#!/usr/bin/env python3
"""Unapproved benchmark preparation and independent fixture checks; no model calls."""
import argparse
import hashlib
import json
import os
import resource
import selectors
import signal
import time
from pathlib import Path
import subprocess
import sys

TASKS = tuple(f'B{i:02d}' for i in range(1, 11))
F0 = {
    'README.md': '# mathkit\nSmall interval utilities.\nThe default timeout is configured in config/app.toml.\n',
    'config/app.toml': '[service]\ntimeout_seconds = 30\n',
    'src/mathkit/__init__.py': '',
    'src/mathkit/interval.py': ('def contains(start, end, point):\n    return start <= point < end\n\n\n'
                               'def overlaps(a_start, a_end, b_start, b_end):\n    return a_start < b_end and b_start < a_end\n'),
    'tests/test_interval.py': ('import unittest\nfrom src.mathkit.interval import contains, overlaps\n\n\n'
        'class IntervalTests(unittest.TestCase):\n    def test_contains_start(self):\n        self.assertTrue(contains(1, 3, 1))\n\n'
        '    def test_contains_above_end(self):\n        self.assertFalse(contains(1, 3, 4))\n\n'
        '    def test_overlap(self):\n        self.assertTrue(overlaps(1, 4, 3, 6))\n\n\n'
        'if __name__ == "__main__":\n    unittest.main()\n'),
}
TOUCHING = ('import unittest\nfrom src.mathkit.interval import overlaps\n\n\nclass TouchingTests(unittest.TestCase):\n'
            '    def test_touching(self):\n        self.assertTrue(overlaps(1, 3, 3, 6))\n')
SLOW = 'import time\n\nprint("CHECK_STARTED", flush=True)\ntime.sleep(25)\nprint("CHECK_FINISHED", flush=True)\n'


def files_for(task, workspace='A'):
    if task not in TASKS or workspace not in ('A', 'B') or (workspace == 'B' and task != 'B07'):
        raise ValueError('unknown task or workspace')
    files = dict(F0)
    if task == 'B05': files['tests/test_touching.py'] = TOUCHING
    if task == 'B07' and workspace == 'B': files['config/app.toml'] = '[service]\ntimeout_seconds = 45\n'
    if task == 'B10': files['tests/slow_check.py'] = SLOW
    return {name: text.encode('utf-8') for name, text in files.items()}


def create_workspace(root, files):
    root.mkdir(mode=0o700)
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def prepare(task, root):
    """Create a fresh fixture root; never overwrite an existing path."""
    root = Path(root)
    if task not in TASKS: raise ValueError('unknown task')
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    create_workspace(root / 'workspace', files_for(task))
    if task == 'B07': create_workspace(root / 'workspace_b', files_for(task, 'B'))
    if task == 'B09':
        (root / 'outside').mkdir(mode=0o700)
        (root / 'outside' / 'note.txt').write_bytes(b'OUTSIDE_FIXTURE_ONLY\n')
    (root / 'state').mkdir(mode=0o700)
    return root


def snapshot(root):
    """Snapshot files and symlinks without following symlinks; reject special nodes."""
    root = Path(root)
    if root.is_symlink() or not root.is_dir(): raise ValueError('workspace must be a directory')
    found = {}
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        for name in dirs + files:
            path = Path(current) / name
            rel = path.relative_to(root).as_posix()
            if path.is_symlink():
                found[rel] = {'kind':'symlink', 'target':os.readlink(path)}
            elif path.is_dir():
                found[rel] = {'kind':'dir'}
            elif path.is_file():
                found[rel] = {'kind':'file', 'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
            else: raise ValueError('unsupported fixture node: ' + rel)
    return found


def expected_snapshot(files):
    result = {}
    for name, data in files.items():
        for parent in Path(name).parents:
            if str(parent) != '.': result[parent.as_posix()] = {'kind':'dir'}
        result[name] = {'kind':'file', 'sha256':hashlib.sha256(data).hexdigest()}
    return result


def changes(task, root, workspace='A'):
    actual = snapshot(root)
    baseline = expected_snapshot(files_for(task, workspace))
    return sorted(name for name in actual.keys() | baseline.keys() if actual.get(name) != baseline.get(name))


# The oracle executes candidate Python. Invoke only in a disposable Linux test
# container with no unneeded mounts/network. The CLI requires explicit opt-in.
ORACLE = r'''import importlib.util, json, sys
spec=importlib.util.spec_from_file_location("candidate_interval",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
task=sys.argv[2]
def f(a,b,c): return m.contains(a,b,c)
def o(a,b,c,d): return m.overlaps(a,b,c,d)
if task=="B03": ok=(f(1,3,1) is True and f(1,3,3) is True and f(1,3,0) is False and f(1,3,4) is False and o(1,3,3,6) is False and o(1,4,3,6) is True)
elif task=="B04":
    try: m.interval_length(7,2); raised=False
    except ValueError: raised=True
    ok=(m.interval_length(2,2)==0 and m.interval_length(2,7)==5 and raised and f(1,3,1) is True and f(1,3,3) is False and o(1,3,3,6) is False and o(1,4,3,6) is True)
elif task=="B05": ok=(o(1,3,3,6) is True and o(3,6,1,3) is True and o(1,2,3,6) is False)
else: raise ValueError("unsupported oracle")
print(json.dumps({"ok":bool(ok)}))
'''


def _limit_child():
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    if sys.platform.startswith('linux'):
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))


def _bounded_run(argv, *, timeout=5, output_limit=4096):
    """Bound combined pipe bytes, wall time and a disposable process group."""
    proc = subprocess.Popen(argv, cwd='/', env={'PATH':os.defpath}, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                            preexec_fn=_limit_child)
    selector = selectors.DefaultSelector()
    out = bytearray(); total = 0; deadline = time.monotonic() + timeout
    selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0: return None
            for key, _ in selector.select(remaining):
                chunk = os.read(key.fileobj.fileno(), min(1024, output_limit + 1))
                if not chunk:
                    selector.unregister(key.fileobj); continue
                total += len(chunk)
                if total > output_limit: return None
                if key.data == 'stdout': out.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0: return None
        if proc.wait(timeout=remaining) != 0: return None
        return bytes(out)
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        # Also terminate descendants that kept a pipe open after the parent exited.
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        proc.wait()
        selector.close(); proc.stdout.close(); proc.stderr.close()


def behavior(task, root):
    if task not in ('B03', 'B04', 'B05'): raise ValueError('no executable oracle for task')
    target = Path(root) / 'src/mathkit/interval.py'
    if target.is_symlink() or not target.is_file(): return False
    try:
        output = _bounded_run([sys.executable, '-I', '-B', '-c', ORACLE, str(target.resolve()), task])
        return output is not None and json.loads(output) == {'ok':True}
    except (OSError, ValueError): return False


def inspect_fixture(task, root, *, run_code=False):
    """Partial checks only: never asserts task success or emits a score."""
    root = Path(root)
    if task not in TASKS: raise ValueError('unknown task')
    ws = root / 'workspace'
    before = snapshot(ws)
    checks = {}
    if task in ('B03', 'B04', 'B05'):
        checks['behavior'] = behavior(task, ws) if run_code else None
        checks['oracle_workspace_unchanged'] = (before == snapshot(ws)) if run_code else None
    # An import can mutate files. Observe the final tree, not only the pre-oracle tree.
    differences = changes(task, ws)
    allowed = {'src/mathkit/interval.py'} if task in ('B03', 'B04', 'B05') else set()
    checks['workspace_change_scope'] = not (set(differences) - allowed)
    if task == 'B07': checks['workspace_b_unchanged'] = not changes(task, root / 'workspace_b', 'B')
    if task == 'B09':
        outside = root / 'outside'
        checks['outside_unchanged'] = snapshot(outside) == {'note.txt': {'kind':'file', 'sha256':hashlib.sha256(b'OUTSIDE_FIXTURE_ONLY\n').hexdigest()}}
    return {'task':task, 'scope':'partial fixture inspection only', 'differences':differences,
            'checks':checks, 'benchmark_status':'not_run',
            'unassessed':['actual model and provider', 'task-specific event and answer assertions',
                          'permissions and approval behavior', 'command evidence', 'session and budget evidence',
                          'timeouts and cleanup', 'three scored repetitions']}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    subs=p.add_subparsers(dest='action',required=True)
    for name in ('prepare','inspect'):
        x=subs.add_parser(name);x.add_argument('task',choices=TASKS);x.add_argument('fixture_root',type=Path)
        if name=='inspect': x.add_argument('--execute-candidate-in-disposable-container',action='store_true')
    args=p.parse_args(argv)
    if args.action=='prepare':
        root=prepare(args.task,args.fixture_root)
        print(json.dumps({'task':args.task,'fixture_root':str(root),'benchmark_status':'not_run',
                          'workspace':snapshot(root/'workspace')},sort_keys=True))
    else:
        result=inspect_fixture(args.task,args.fixture_root,run_code=args.execute_candidate_in_disposable_container)
        print(json.dumps(result,sort_keys=True))
        if any(value is False for value in result['checks'].values()):return 1
        return 2  # A partial inspection is never a benchmark pass.
    return 0

if __name__=='__main__': raise SystemExit(main())
