#!/usr/bin/env python3
"""Host-only synthetic read-root overlap checks; no Docker daemon or user files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import traceback

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='mount-overlap-', dir=args.evidence_dir)).resolve()
    bin_dir = folder / 'bin'; bin_dir.mkdir()
    log = folder / 'docker.jsonl'
    stub = bin_dir / 'docker'
    stub.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['NOMO_STUB_LOG'], 'a') as f:
    f.write(json.dumps({'args': sys.argv[1:], 'read_root': os.environ.get('NOMO_WORK_CONTEXT_DIR')}) + '\\n')
if sys.argv[1:2] == ['inspect']:
    print('No such object: synthetic', file=sys.stderr)
    sys.exit(1)
sys.exit(97)
''')
    stub.chmod(0o755)
    env = {'PATH': str(bin_dir) + ':/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': '/tmp',
           'PYTHONDONTWRITEBYTECODE': '1', 'NOMO_STUB_LOG': str(log)}
    result = {'status': 'failed', 'scope': 'synthetic paths and Docker stub only; no container or real user files', 'cases': []}
    script = ROOT / 'scripts/local-tryout.sh'
    result['launcher_sha256'] = hashlib.sha256(script.read_bytes()).hexdigest()
    try:
        trial = folder / 'tryout'
        prep = subprocess.run([str(script), 'prepare', str(trial)], cwd=ROOT, env=env, capture_output=True, timeout=20)
        assert prep.returncode == 0, prep.stderr
        alias = folder / 'alias'; alias.symlink_to(trial, target_is_directory=True)
        separate = folder / 'tryout-sibling'; separate.mkdir()
        options = ['--id', 'sample', '--workspace', 'demo', '--path', 'demo/value.txt', '--once', 'Read', '--allow', 'notes/context.txt', '--accept-read-root']
        cases = {'root': '/', 'tryout_ancestor': str(trial), 'workspace': str(trial/'workspace'),
                 'workspace_descendant': str(trial/'workspace/demo'), 'state': str(trial/'state'),
                 'alias_ancestor': str(alias/'workspace/demo'), 'dot_segments': str(trial/'context/../workspace/demo')}
        for name, selected in cases.items():
            assert not log.exists()
            command = [str(script), 'user-context-new', str(trial), '--read-root', selected, *options]
            p = subprocess.run(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
            (folder / (name + '.stdout.bin')).write_bytes(p.stdout)
            (folder / (name + '.stderr.bin')).write_bytes(p.stderr)
            assert p.returncode == 64 and b'read root must not overlap writable tryout workspace or state' in p.stderr
            assert not log.exists() and not list((trial/'state').iterdir())
            result['cases'].append({'name': name, 'exit': p.returncode, 'docker_called': False, 'state_empty': True})
        # Run the exact embedded path check with owned sibling-prefix paths and a
        # missing path, which the launcher's earlier directory check also rejects.
        content = script.read_text(); snippet = content.split("<<'PY_PATHS'\n", 1)[1].split('\nPY_PATHS\n', 1)[0]
        pair = folder/'prefix'; pair.mkdir(); (pair/'workspace').mkdir(); (pair/'workspace-extra').mkdir(); (pair/'state').mkdir(); (pair/'state/child').mkdir()
        for name, selected, expected in [('sibling_prefix', pair/'workspace-extra', 0), ('state_descendant', pair/'state/child', 1), ('missing_resolution', pair/'missing', 1)]:
            p = subprocess.run(['python3', '-c', snippet, str(selected), str(pair/'workspace'), str(pair/'state')], env=env, capture_output=True, timeout=20)
            assert p.returncode == expected
            result['cases'].append({'name': name, 'exit': p.returncode, 'scope': 'exact embedded Python preflight'})
        selected = str(separate) + '///'
        p = subprocess.run([str(script), 'user-context-new', str(trial), '--read-root', selected, *options], cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        (folder/'valid.stdout.bin').write_bytes(p.stdout); (folder/'valid.stderr.bin').write_bytes(p.stderr)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        compose = [x for x in calls if x['args'][:1] == ['compose']]
        assert p.returncode == 97 and len(compose) == 1
        actual = compose[0]['args']; selected_args = actual[actual.index('--args')+1:]
        assert selected_args == ['--read-root', str(separate), '--input-mode', 'non-tty', *options]
        assert compose[0]['read_root'] == str(separate) and not list((trial/'state').iterdir())
        result['cases'].append({'name': 'separate_root', 'exit': p.returncode, 'docker_stub_called': True, 'exact_args': True, 'state_empty': True})
        result['status'] = 'passed'
    except BaseException:
        result['failure'] = traceback.format_exc()
    (folder/'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'evidence': str(folder), 'failure': result.get('failure')}))
    return 0 if result['status'] == 'passed' else 1

if __name__ == '__main__':
    raise SystemExit(main())
