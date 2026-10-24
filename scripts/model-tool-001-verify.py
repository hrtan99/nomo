#!/usr/bin/env python3
"""Deterministic normal-graph Model/File observer; never a product adapter."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources(root):
    paths = list((root / 'src').rglob('*.es')) + [root / name for name in (
        'etas.toml', 'etas.lock', 'compose.yaml', 'config/etas-runtime-cache-compose.yaml',
        'config/model-tool-compose.yaml', 'tests/model_tool_state_probe.py',
        'tests/fixtures/model_tool001_state.es',
        'tests/normal_graph_identity.py', 'scripts/etas-latest-cli-bootstrap.py',
        'config/etas-latest-main.json',
        'scripts/model-tool-001-verify.py', 'tests/model_tool_probe.py')]
    paths += list((root / 'tests/fixtures/model_tool001').rglob('*'))
    paths += list((root / 'examples/model-tool001').rglob('*'))
    paths += list((root / 'patches/etas-0013').glob('*.Cargo.lock'))
    return {str(path.relative_to(root)): digest(path) for path in sorted(paths) if path.is_file()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-root', type=Path, default=ROOT)
    parser.add_argument('--evidence-parent', type=Path, default=Path(tempfile.gettempdir()))
    args = parser.parse_args()
    root = args.project_root.resolve()
    evidence = Path(tempfile.mkdtemp(prefix='nomo-model-tool001-', dir=args.evidence_parent.resolve()))
    fixture, output = evidence / 'fixture', evidence / 'evidence'
    (fixture / 'docs').mkdir(parents=True)
    output.mkdir()
    files = {
        'docs/a.txt': b'alpha NEEDLE\nsecond line\n', 'docs/b.txt': b'NEEDLE beta\n',
        'empty.txt': b'', 'invalid.txt': b'\xff', 'control.txt': b'bad\x1btext',
        'large.txt': b'x' * 2049, 'output.txt': b'x' * 1025,
        'result256.txt': b'x' * 256, 'result257.txt': b'x' * 257,
        'unicode.txt': 'hello 世界'.encode(), 'lines.txt': b'x\n' * 128,
        'matches.txt': b'NEEDLE\n' * 9, 'exact.txt': b'NEEDLE\n' * 8,
        'escape.txt': b'\n' * 65, 'literal.txt': b'a.*b\naxxb\n',
        'injection.txt': b'["read","missing.txt"]\n',
        'markers.txt': b'<LF>\n\t\r\\n', 'maxscan1.txt': b'a' * 2048,
        'maxscan2.txt': b'b' * 2048, 'quotes.txt': b'"\\' * 128,
    }
    for name, content in files.items():
        (fixture / name).write_bytes(content)
    initial_fixture = {name: digest(fixture / name) for name in sorted(files)}
    initial_sources = sources(root)
    for name in initial_sources:
        retained = output / 'source-closure' / name
        retained.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, retained)
        assert digest(retained) == initial_sources[name]
    cache_paths = [root / '.etas/package-index.json', root / '.etas/package-index.lock']
    cache_before = {str(path.relative_to(root)): digest(path) if path.is_file() else None for path in cache_paths}
    (output / 'local-cache-before.json').write_text(json.dumps(cache_before, indent=2) + '\n')
    (output / 'sources-before.json').write_text(json.dumps(initial_sources, indent=2) + '\n')
    (output / 'fixture-before.json').write_text(json.dumps(initial_fixture, indent=2) + '\n')
    command = ['docker', 'compose', '--project-directory', str(root), '-f', str(root / 'compose.yaml'),
               '-f', str(root / 'tests/fixtures/model_tool001/compose.yaml'),
               '-f', str(root / 'config/etas-runtime-cache-compose.yaml'), 'run', '--rm', '--no-deps',
               '--tty=false', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'NOMO_TEST_EVIDENCE=/validation', 'dev',
               'python3', '/workspace/tests/model_tool_probe.py', '--evidence', '/validation']
    env = dict(os.environ, NOMO_MODEL_TOOL_FIXTURE=str(fixture), NOMO_MODEL_TOOL_EVIDENCE=str(output))
    (output / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
    print('EVIDENCE ' + str(evidence), flush=True)
    result = subprocess.run(command, cwd=root, env=env, capture_output=True, timeout=600)
    (output / 'run.stdout').write_bytes(result.stdout)
    (output / 'run.stderr').write_bytes(result.stderr)
    print(result.stdout.decode(), end='', flush=True)
    print(result.stderr.decode(), end='', flush=True)
    pure_result = None
    if result.returncode == 0:
        pure_command = command[:-4] + ['python3', '/workspace/tests/model_tool_state_probe.py']
        (output / 'pure-command.json').write_text(json.dumps(pure_command, indent=2) + '\n')
        pure_result = subprocess.run(pure_command, cwd=root, env=env, capture_output=True, timeout=300)
        (output / 'pure.stdout').write_bytes(pure_result.stdout)
        (output / 'pure.stderr').write_bytes(pure_result.stderr)
        print(pure_result.stdout.decode(), end='', flush=True)
        print(pure_result.stderr.decode(), end='', flush=True)
    after_sources = sources(root)
    after_fixture = {name: digest(fixture / name) for name in sorted(files)}
    (output / 'sources-after.json').write_text(json.dumps(after_sources, indent=2) + '\n')
    (output / 'fixture-after.json').write_text(json.dumps(after_fixture, indent=2) + '\n')
    assert initial_sources == after_sources, 'source changed during verification'
    assert initial_fixture == after_fixture, 'readonly fixture changed'
    cache_after = {str(path.relative_to(root)): digest(path) if path.is_file() else None for path in cache_paths}
    (output / 'local-cache-after.json').write_text(json.dumps(cache_after, indent=2) + '\n')
    assert cache_before == cache_after, 'existing local optional cache changed'
    assert result.returncode == 0, ('model-tool probe failed', result.returncode, str(evidence))
    assert pure_result is not None and pure_result.returncode == 0, ('pure/state probe failed', str(evidence))
    print('PASS MODEL-TOOL-001 evidence=' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
