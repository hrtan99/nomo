"""Settle a persisted result in a new Etas process; no model or project I/O."""
from pathlib import Path
from native_sources import copy_sources
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
    copy_sources(ROOT, package, ROOT / 'tests/fixtures/native_receipt/src/app/main.es')
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
    for name in ('compose.yaml', 'config/etas-0246-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--allow-effects']
    print('EVIDENCE ' + str(evidence), flush=True)
    outputs = {}
    for mode in ('seed', 'settle', 'seed-incomplete', 'settle-incomplete', 'command-port'):
        result = subprocess.run(command + ['--trace-out', '/state/' + mode + '-trace.json', '--args', mode], cwd=ROOT, capture_output=True, text=True)
        (evidence / (mode + '-stdout.txt')).write_text(result.stdout)
        (evidence / (mode + '-stderr.txt')).write_text(result.stderr)
        outputs[mode] = result.stdout
        if mode == 'seed-incomplete':
            assert result.returncode != 0 and 'fixture interrupted before result archive completion' in result.stdout + result.stderr
        else:
            assert result.returncode == 0, result.stdout + result.stderr
    assert 'SETTLED original result retained' in outputs['settle']
    assert 'INCOMPLETE reserved result retained as unknown' in outputs['settle-incomplete']
    assert 'COMMAND PORT recorded exact argv/stdin' in outputs['command-port']
    trace = json.loads((state / 'command-port-trace.json').read_text())
    assert trace['outcome']['kind'] == 'completed'
    assert not any(event.get('qualified_action') == 'Command.run' for event in trace['events'])
    print('PASS native result publication + new-process pending cleanup: ' + str(evidence))


if __name__ == '__main__':
    main()
