#!/usr/bin/env python3
"""Compile and run the isolated pure known-literal event projection fixture."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CLI = Path('/home/nomo/.cargo/bin/etas')
MANIFEST = '''[package]
name = "recoverable-events-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "recoverable-events-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.recoverable_events_probe"
flow = "recoverable_events_probe"
profile = "fixture"
'''


def main():
    spec = json.loads((ROOT / 'config/etas-025-official.json').read_text())
    digest = hashlib.sha256(CLI.read_bytes()).hexdigest()
    if digest != spec['verified_seed_binary_sha256']:
        raise ValueError('official CLI identity mismatch')
    with tempfile.TemporaryDirectory(prefix='recoverable-events-') as temp:
        project = Path(temp) / 'project'
        project.mkdir()
        shutil.copytree(ROOT / 'src', project / 'src')
        (project / 'src/app').mkdir()
        shutil.copyfile(ROOT / 'tests/fixtures/recoverable_events/probe.es', project / 'src/app/recoverable_events_probe.es')
        (project / 'etas.toml').write_text(MANIFEST)
        checks = []
        for command in ([str(CLI), 'check', '--all', str(project)],
                        [str(CLI), 'run', str(project), '--flow', 'recoverable_events_probe', '--allow-effects']):
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            checks.append({'exit': result.returncode, 'stdout': result.stdout[-4000:], 'stderr': result.stderr[-4000:]})
            if result.returncode or result.stderr:
                break
        success = len(checks) == 2 and checks[-1]['exit'] == 0 and checks[-1]['stdout'].startswith('PASS recoverable event projection:')
        print(json.dumps({'status': 'passed' if success else 'failed', 'scope': 'pure synthetic exact-known-literal projection; no storage integration or complete redaction', 'cli_sha256': digest, 'checks': checks}, indent=2))
        return 0 if success else 1


if __name__ == '__main__':
    raise SystemExit(main())
