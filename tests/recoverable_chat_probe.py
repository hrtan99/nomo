#!/usr/bin/env python3
"""Synthetic cross-process atomic chat/event record using the official CLI."""
from contextlib import closing
import base64
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CLI = Path('/home/nomo/.cargo/bin/etas')
MANIFEST = '''[package]
name = "recoverable-chat-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "recoverable-chat-probe"
[runtime.profiles.fixture.memory]
backend = "sqlite"
path = "history.sqlite3"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow", "memory=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.recoverable_chat_probe"
flow = "recoverable_chat_probe"
profile = "fixture"
'''


def main():
    expected = json.loads((ROOT / 'config/etas-latest-main.json').read_text())['verified_seed_binary_sha256']
    digest = hashlib.sha256(CLI.read_bytes()).hexdigest()
    if digest != expected:
        raise ValueError('official CLI identity mismatch')
    with tempfile.TemporaryDirectory(prefix='recoverable-chat-') as temp:
        work = Path(temp)
        project = work / 'project'
        project.mkdir()
        shutil.copytree(ROOT / 'src', project / 'src')
        (project / 'src/app').mkdir()
        shutil.copyfile(ROOT / 'tests/fixtures/recoverable_chat/probe.es', project / 'src/app/recoverable_chat_probe.es')
        (project / 'etas.toml').write_text(MANIFEST)
        checks = []
        commands = [[str(CLI), 'check', '--all', str(project)]]
        commands += [[str(CLI), 'run', str(project), '--flow', 'recoverable_chat_probe', '--allow-effects', '--args', phase]
                     for phase in ('reserve-first', 'first-finish', 'reserve-second', 'finish-second', 'inspect',
                                   'reserve-third-large', 'finish-third-large', 'reserve-fourth-large',
                                   'finish-fourth-large', 'inspect-conversation')]
        for command in commands:
            result = subprocess.run(command, capture_output=True, text=True, cwd=work, timeout=120)
            checks.append({'exit': result.returncode, 'stdout': result.stdout[-1500:], 'stderr': result.stderr[-3000:]})
            if result.returncode or result.stderr:
                break
        success = len(checks) == len(commands) and all(item['exit'] == 0 for item in checks)
        artifacts = {}
        if success:
            with closing(sqlite3.connect(work / 'history.sqlite3')) as db:
                assert db.execute('pragma integrity_check').fetchone() == ('ok',)
                rows = db.execute("select value_json from memory_entries where region='nomo-recoverable-chat-v1'").fetchall()
                assert len(rows) == 1 and rows[0][0].count('complete: port=4321') >= 2
                assert 'VERY_SECRET_123' not in rows[0][0]
            for path in work.glob('history.sqlite3*'):
                data = path.read_bytes()
                assert b'VERY_SECRET_123' not in data and len(data) <= 1048576
                artifacts[path.name] = {'sha256': hashlib.sha256(data).hexdigest(), 'base64': base64.b64encode(data).decode('ascii')}
        print(json.dumps({'status': 'passed' if success else 'failed', 'scope': 'isolated synthetic CAS chat/event frame; no production routing or comprehensive redaction', 'cli_sha256': digest, 'checks': checks, 'synthetic_sqlite_artifacts': artifacts}, indent=2))
        return 0 if success else 1


if __name__ == '__main__':
    raise SystemExit(main())
