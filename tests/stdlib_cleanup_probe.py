"""Positive text, builder and collection regressions; no model or project mutation."""
import hashlib
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from native_sources import copy_sources

ROOT = Path(__file__).resolve().parents[1]
CHECKS = {'run': 8, 'unicode': 3, 'search': 2, 'references': 2, 'recall': 1,
          'path_selection': 1, 'picker': 1, 'admission': 1}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--flow', action='append', choices=CHECKS)
    selected = parser.parse_args().flow or list(CHECKS)
    evidence = Path(tempfile.mkdtemp(prefix='nomo-stdlib-cleanup-')).resolve()
    project = evidence / 'project'
    sources = copy_sources(ROOT, project, ROOT / 'tests/fixtures/stdlib_cleanup/probe.es')
    # Exercise the private byte selector independently of full-stream redaction.
    # The staged observer adds visibility only, never an alternative algorithm.
    codec = project / 'src/nomo/domain/sessions/event_codec.es'
    codec.write_text(codec.read_text() + '\npublic flow probe_excerpt(clean: string) -> string { return excerpt(clean); }\n')
    sources['fixture-observer:src/nomo/domain/sessions/event_codec.es'] = hashlib.sha256(codec.read_bytes()).hexdigest()
    entry = project / 'src/app/main.es'
    scalar_codes = [0, 1, 8, 9, 10, 12, 13, 34, 92, 127, 128, 159, 8206, 21069, 65535, 128512, 1114111]
    scalar_json = [json.dumps([chr(code)], ensure_ascii=code >= 128, separators=(',', ':')) if code != 127 else '' for code in scalar_codes]
    clip_input = 'a' * 1998 + '😀' + 'middle' * 20 + '尾' * 667
    clean = clip_input.encode()
    excerpt = clean[:2000].decode('utf-8', errors='ignore') + '\n[... output omitted ...]\n' + clean[-2000:].decode('utf-8', errors='ignore')
    fixture = evidence / 'search'
    fixture.mkdir()
    files = {'a.txt': b'needle\r\nother\nneedle\n', '鹈鹕.txt': 'other\r\nneedle\r\n'.encode(), 'hits.txt': b'n\n' * 128}
    for name, body in files.items():
        (fixture / name).write_bytes(body)
    replacements = {'__LARGE_TEXT__': json.dumps('x' * 1048576), '__SCALAR_JSON__': json.dumps(scalar_json),
                    '__EXCERPT_INPUT__': json.dumps(clip_input, ensure_ascii=False), '__EXCERPT_EXPECTED__': json.dumps(excerpt, ensure_ascii=False),
                    '__SEARCH_BYTES__': str(len(files['a.txt']) + len(files['鹈鹕.txt'])), '__OPTIONAL_LARGE__': json.dumps('x' * 2048)}
    source = entry.read_text()
    for name, value in replacements.items():
        source = source.replace(name, value)
    entry.write_text(source)
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
rules = ["console=allow", "filesystem:Fs.read=allow"]
[runtime.profiles.fixture.filesystem.regions."nomo.tools.workspace.ReadOnlyRoot"]
root = "/search-fixture"
read = true
write = false
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
        {'type': 'bind', 'source': str(project), 'target': '/workspace', 'read_only': True},
        {'type': 'bind', 'source': str(fixture), 'target': '/search-fixture', 'read_only': True}]}}}))
    command = ['docker', 'compose', '--project-name', 'nomo-stdlib-cleanup', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-02413-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', '--no-config', '--cache', 'off', 'run', '/workspace',
                '--allow-effects']
    print('EVIDENCE ' + str(evidence), flush=True)
    (evidence / 'sources.json').write_text(json.dumps(sources, indent=2) + '\n')
    for flow in selected:
        result = subprocess.run(command + ['--flow', flow], cwd=ROOT, capture_output=True, input=b'2\n', timeout=180)
        (evidence / (flow + '.stdout.txt')).write_bytes(result.stdout)
        (evidence / (flow + '.stderr.txt')).write_bytes(result.stderr)
        print(result.stdout.decode(), end='', flush=True)
        assert result.returncode == 0 and result.stdout.count(b'PASS ') == CHECKS[flow], result.stderr.decode()
    (evidence / 'result.json').write_text(json.dumps({'status': 'passed', 'positive_checks': sum(CHECKS[flow] for flow in selected), 'flows': selected,
        'model_requests': 0, 'project_mutations': 0, 'command': command}, indent=2) + '\n')


if __name__ == '__main__':
    main()
