"""Settle a persisted result in a new Etas process; no model or project I/O."""
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-receipt-')).resolve()
    package, state = evidence / 'package', evidence / 'state'
    package.mkdir()
    (package / '.etas').mkdir()
    state.mkdir(mode=0o777)
    state.chmod(0o777)
    for name in ('src/nomo/native/history.es', 'src/nomo/native/lifecycle.es', 'src/nomo/core/json.es'):
        target = package / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    main_file = package / 'src/app/main.es'
    main_file.parent.mkdir()
    main_file.write_bytes((ROOT / 'tests/fixtures/native_receipt/src/app/main.es').read_bytes())
    (package / 'etas.toml').write_text('''[package]
name = "native-receipt"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.memory]
backend = "sqlite"
path = "/state/history.sqlite3"
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["memory=allow", "console=allow"]
[[bin]]
name = "native-receipt"
module = "app.main"
flow = "main"
''')
    (package / 'etas.lock').write_text('version = 1\nmanifest_fingerprint = "etas-lock-input:v1|package=native-receipt|version=0.1.0|edition=2026"\npackage = []\n')
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {'volumes': [
        {'type': 'bind', 'source': str(package), 'target': '/workspace', 'read_only': True},
        {'type': 'bind', 'source': str(state), 'target': '/state'}]}}}))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0134-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--allow-effects', '--args']
    print('EVIDENCE ' + str(evidence), flush=True)
    for mode in ('seed', 'settle'):
        result = subprocess.run(command + [mode], cwd=ROOT, capture_output=True, text=True)
        (evidence / (mode + '-stdout.txt')).write_text(result.stdout)
        (evidence / (mode + '-stderr.txt')).write_text(result.stderr)
        assert result.returncode == 0, result.stdout + result.stderr
    assert 'SETTLED original result retained' in result.stdout
    print('PASS native result publication + new-process pending cleanup: ' + str(evidence))


if __name__ == '__main__':
    main()
