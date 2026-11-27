"""Positive text, builder and collection regressions; no model or project mutation."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from native_sources import copy_sources

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-stdlib-cleanup-')).resolve()
    project = evidence / 'project'
    sources = copy_sources(ROOT, project, ROOT / 'tests/fixtures/stdlib_cleanup/probe.es')
    entry = project / 'src/app/main.es'
    entry.write_text(entry.read_text().replace('__LARGE_TEXT__', json.dumps('x' * 1048576)))
    sources['generated:src/app/main.es'] = hashlib.sha256(entry.read_bytes()).hexdigest()
    (project / '.etas').mkdir()
    (project / 'etas.toml').write_text('''[package]
name = "stdlib-cleanup"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "stdlib-cleanup"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.main"
flow = "run"
profile = "fixture"
''')
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {'volumes': [
        {'type': 'bind', 'source': str(project), 'target': '/workspace', 'read_only': True}]}}}))
    command = ['docker', 'compose', '--project-name', 'nomo-stdlib-cleanup', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-02413-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', '--no-config', '--cache', 'off', 'run', '/workspace',
                '--flow', 'run', '--allow-effects']
    print('EVIDENCE ' + str(evidence), flush=True)
    result = subprocess.run(command, cwd=ROOT, capture_output=True)
    (evidence / 'stdout.txt').write_bytes(result.stdout)
    (evidence / 'stderr.txt').write_bytes(result.stderr)
    (evidence / 'sources.json').write_text(json.dumps(sources, indent=2) + '\n')
    print(result.stdout.decode(), end='', flush=True)
    assert result.returncode == 0 and result.stdout.count(b'PASS ') == 8, result.stderr.decode()
    (evidence / 'result.json').write_text(json.dumps({'status': 'passed', 'positive_checks': 8,
        'model_requests': 0, 'project_mutations': 0, 'command': command}, indent=2) + '\n')


if __name__ == '__main__':
    main()
