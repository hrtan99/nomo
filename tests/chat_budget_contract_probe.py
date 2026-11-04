#!/usr/bin/env python3
"""Exercise versioned chat reservations with the selected official ETAS CLI."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

root = Path('/workspace')
with tempfile.TemporaryDirectory(prefix='nomo-chat-budget-') as directory:
    project = Path(directory)
    shutil.copytree(root / 'src', project / 'src')
    (project / 'src/app').mkdir()
    shutil.copyfile(root / 'tests/fixtures/chat_budget/contract_probe.es', project / 'src/app/main.es')
    (project / 'etas.toml').write_text('''[package]
name = "nomo-chat-budget-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "chat-budget-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.main"
flow = "probe"
profile = "fixture"
''')
    command = ['python3', '-B', str(root / 'scripts/nomo-verified-etas.py'), 'run', str(project), '--flow', 'probe', '--allow-effects']
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    print(json.dumps({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}))
    if result.returncode or 'PASS new and legacy reservations' not in result.stdout:
        raise SystemExit(1)
