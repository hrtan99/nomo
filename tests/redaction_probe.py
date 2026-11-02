#!/usr/bin/env python3
"""Exercise bounded exact-match redaction without Model/File access."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = '''[package]
name = "redaction-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "redaction-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.redaction_probe"
flow = "redaction_probe"
profile = "fixture"
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--etas', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    options = parser.parse_args()
    assert options.etas.is_absolute() and digest(options.etas) == options.sha256
    out = Path(tempfile.mkdtemp(prefix='read-unicode-', dir=options.evidence_dir))
    project = out / 'project'
    project.mkdir()
    shutil.copytree(ROOT / 'src', project / 'src')
    (project / 'src/app').mkdir()
    shutil.copyfile(ROOT / 'tests/fixtures/redaction/probe.es', project / 'src/app/redaction_probe.es')
    (project / 'etas.toml').write_text(MANIFEST)
    sources = {str(p.relative_to(project)): digest(p) for p in (project / 'src').rglob('*.es')}
    result = {'status': 'failed', 'scope': 'exact known-literal redaction contract only, no Model or File dispatch', 'commands': []}
    try:
        for name, argv in [('check', ['check', '--all', str(project)]),
                           ('run', ['run', str(project), '--flow', 'redaction_probe', '--allow-effects'])]:
            p = subprocess.run([str(options.etas), *argv], capture_output=True, timeout=240)
            (out / (name + '.stdout')).write_bytes(p.stdout)
            (out / (name + '.stderr')).write_bytes(p.stderr)
            result['commands'].append({'name': name, 'exit': p.returncode})
            assert p.returncode == 0 and not p.stderr
            if name == 'check':
                assert p.stdout == ('checked ' + str(len(sources)) + ' files\n').encode()
            else:
                assert p.stdout.endswith(b'PASS bounded exact-match redaction; no automatic secret discovery\n')
        assert all(digest(project / name) == value for name, value in sources.items())
        assert digest(options.etas) == options.sha256
        result['status'] = 'passed'
    except BaseException as error:
        result['failure_type'] = type(error).__name__
    (out / 'result.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'evidence': str(out)}))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
