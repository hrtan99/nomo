#!/usr/bin/env python3
"""Exercise four-turn in-memory admission and accounting without a model."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = '''[package]
name = "user-context-chat-four-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "chat-four-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.chat_four_probe"
flow = "read_chat_four_probe"
profile = "fixture"
'''


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources(root):
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob('*.es')) if p.is_file() and not p.is_symlink()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--etas', type=Path, required=True)
    parser.add_argument('--expected-cli-sha256', required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    assert args.etas.is_absolute() and not args.etas.is_symlink() and sha(args.etas) == args.expected_cli_sha256
    out = Path(tempfile.mkdtemp(prefix='chat-four-', dir=args.evidence_dir))
    project = out / 'project'
    project.mkdir()
    shutil.copytree(ROOT / 'src', project / 'src')
    (project / 'src/app').mkdir()
    shutil.copyfile(ROOT / 'tests/fixtures/read_chat_four/probe.es', project / 'src/app/chat_four_probe.es')
    (project / 'etas.toml').write_text(MANIFEST)
    before = sources(project / 'src')
    result = {'status': 'failed', 'scope': 'synthetic in-memory accounting only; no model or filesystem actions', 'commands': []}
    try:
        commands = [('check', ['check', '--all', str(project)]),
                    ('effects', ['--format', 'json', 'effects', str(project), '--flow', 'read_chat_four_probe']),
                    ('run', ['run', str(project), '--flow', 'read_chat_four_probe', '--allow-effects'])]
        for label, command in commands:
            done = subprocess.run([str(args.etas), *command], stdin=subprocess.DEVNULL, capture_output=True, timeout=240)
            (out / (label + '.stdout')).write_bytes(done.stdout)
            (out / (label + '.stderr')).write_bytes(done.stderr)
            result['commands'].append({'name': label, 'exit': done.returncode})
            assert done.returncode == 0 and not done.stderr
            if label == 'check':
                assert done.stdout == ('checked ' + str(len(before)) + ' files\n').encode()
            elif label == 'effects':
                items = json.loads(done.stdout)['items']
                assert len(items) == 1
                def actions(value):
                    assert value.startswith('[') and value.endswith(']')
                    return set(value[1:-1].split(', ')) if value != '[]' else set()
                assert actions(items[0]['requested_actions']) == {'Console.stdout_write'}
                assert actions(items[0]['default_actions']) == {'Console.stdout_write'}
            else:
                assert done.stdout == b'PASS four-turn admission and accounting\n'
        assert sources(project / 'src') == before and sha(args.etas) == args.expected_cli_sha256
        result['status'] = 'passed'
    except BaseException as error:
        result['failure_type'] = type(error).__name__
    (out / 'result.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'evidence': str(out)}))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
