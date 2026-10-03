#!/usr/bin/env python3
"""Verify normal graph adoption with read-only sources/cache and synthetic stores."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('normal_bootstrap', ROOT / 'scripts/etas-0013-cli-bootstrap.py')
BOOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BOOT)
GRAPH = BOOT.ROOT
CLI = BOOT.INSTALLED
HOST = GRAPH / 'target/debug/nomo-session-store-host-faults'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def sources():
    paths = [ROOT / name for name in ('etas.toml', 'etas.lock', 'compose.yaml', 'Dockerfile')]
    for directory in ('src', 'packages', 'tests', 'scripts', 'config', 'patches', 'examples'):
        paths += [path for path in (ROOT / directory).rglob('*') if path.is_file()
                  and path.suffix in ('.es', '.rs', '.py', '.sh', '.toml', '.yaml', '.lock')
                  and not {'__pycache__', 'target', '.etas'}.intersection(path.parts)]
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(set(paths))}


def host_guard():
    identity = read(GRAPH / 'host-faults-identity.json')
    assert identity['fixed_revisions'] == {name: pin[1] for name, pin in BOOT.PINS.items()}
    assert digest(HOST) == identity['fixture_binary_sha256']
    assert digest(GRAPH / 'host-faults/Cargo.lock') == identity['fixture_lock_sha256']
    for name, fingerprint in identity['fixture_source_sha256'].items():
        assert digest(GRAPH / 'host-faults' / name) == fingerprint
        assert digest(ROOT / 'tests/fixtures/session_store/host_faults' / name) == fingerprint
    approved = {(p['name'], p['version'], p['source']) for p in read(GRAPH / 'cli-metadata.json')['packages']}
    expected = {package: str(BOOT.SOURCE / name / 'crates' / package / 'Cargo.toml')
                for name, (_, _, _, packages) in BOOT.PINS.items() if name != 'cli' for package in packages.split()}
    origins = {}
    for package in read(GRAPH / 'host-faults-metadata.json')['packages']:
        name = package['name']
        if name == 'nomo-session-store-host-faults':
            continue
        assert (name, package['version'], package['source']) in approved, ('fixture dependency drift', name)
        if name.startswith('etas_'):
            assert name not in origins and package['source'] is None
            assert package['manifest_path'] == expected[name]
            origins[name] = package['manifest_path']
    assert origins == expected == read(GRAPH / 'host-faults-origins.json')
    return identity


def main():
    destination = Path(os.environ['NOMO_TEST_EVIDENCE'])
    assert destination.is_dir() and destination.resolve() == destination
    assert destination != GRAPH and GRAPH not in destination.parents, 'evidence must be outside read-only graph'
    for point in ('/workspace', '/home/nomo/.cargo'):
        mount = next(row.split() for row in Path('/proc/self/mountinfo').read_text().splitlines()
                     if row.split()[4] == point)
        assert 'ro' in mount[5].split(','), ('read-only mount required', point)
    evidence = Path(tempfile.mkdtemp(prefix='etas-adopt-0013-', dir=destination))
    print('EVIDENCE ' + str(evidence), flush=True)
    summary = {'status': 'running', 'graph': str(GRAPH), 'commands': [],
               'scope': 'normal exact graph, adopted prepared publication, existing full normal/storage/entry suites',
               'historical_match_observer': 'not rerun; its expected failures belong to the old isolated graph',
               'ordinary_demo': 'separate SESSION-CLI-001B delivery'}
    lock = threading.RLock()
    env = dict(os.environ, NOMO_NORMAL_GRAPH='etas0013', SESSION_STORE_GRAPH=str(GRAPH),
               ETAS=str(CLI), NOMO_TEST_EVIDENCE=str(evidence), PYTHONDONTWRITEBYTECODE='1')
    summary['environment'] = {key: env.get(key) for key in (
        'NOMO_NORMAL_GRAPH', 'SESSION_STORE_GRAPH', 'ETAS', 'NOMO_TEST_EVIDENCE',
        'CARGO_HOME', 'CARGO_TARGET_DIR', 'XDG_CACHE_HOME', 'PYTHONDONTWRITEBYTECODE')}

    def save():
        with lock:
            (evidence / 'results.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False))

    def run(command, timeout=1200, expected=0, inputs=None):
        item = {'command': list(map(str, command)), 'cwd': str(ROOT),
                'expected_exit': expected, 'timeout': timeout}
        if inputs is not None:
            item['inputs'] = inputs
        with lock:
            summary['commands'].append(item)
            save()
        print('+ ' + ' '.join(item['command']), flush=True)
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            with lock:
                item.update(timeout_expired=True, stdout=str(error.stdout or ''), stderr=str(error.stderr or ''))
                save()
            raise
        with lock:
            item.update(exit=result.returncode, stdout=result.stdout, stderr=result.stderr)
            save()
        if result.stdout:
            print(result.stdout, end='', flush=True)
        if result.stderr:
            print(result.stderr, end='', file=sys.stderr, flush=True)
        assert result.returncode == expected, ('unexpected exit', item)
        return result

    try:
        summary['sources_before'] = sources()
        for name, fingerprint in summary['sources_before'].items():
            copied = evidence / 'workspace-inputs' / name
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, copied)
            assert digest(copied) == fingerprint
        run(['python3', '-B', str(ROOT / 'scripts/etas-0013-cli-bootstrap.py'), 'verify', '--read-only'])
        summary['provenance'] = read(GRAPH / 'identity.json')
        summary['binary'] = read(GRAPH / 'binary.json')
        summary['host_fixture'] = host_guard()
        # This materialized project is test-only; it is not the ordinary demo path.
        os.environ.update({key: env[key] for key in ('SESSION_STORE_GRAPH', 'ETAS', 'NOMO_TEST_EVIDENCE')})
        sys.path.insert(0, str(ROOT / 'tests'))
        from session_store_probe import fixture_source, materialize, retain_input
        project = evidence / 'phase-check'
        source = materialize(project)
        source.write_text(fixture_source('stub'))
        summary['phase_project'] = str(project)
        run([str(CLI), 'check', str(project)], inputs=retain_input(project, source))
        run([str(CLI), 'check', '--all', str(project)], inputs=retain_input(project, source))
        phase = run([str(CLI), 'check', '--phase1', str(project)], expected=1,
                    inputs=retain_input(project, source))
        assert 'RuntimeRequiredInPhase1' in phase.stderr and 'error[' not in phase.stderr
        jobs = [
            (ROOT / 'scripts/session-001a-verify.py', [], 1200),
            (ROOT / 'tests/session_store_codec_probe.py', [], 600),
            (ROOT / 'tests/session_store_probe.py', [], 900),
            (ROOT / 'tests/session_store_probe.py', ['--negative-only'], 900),
            (ROOT / 'tests/session_store_bounds_probe.py', [], 1200),
            (ROOT / 'tests/session_store_fault_probe.py', [], 1200),
            (ROOT / 'tests/session_cli_mapping_probe.py', [], 600),
            (ROOT / 'tests/session_cli_probe.py', [], 1800),
            (ROOT / 'tests/test_sloc_counter.py', [], 60),
        ]
        with ThreadPoolExecutor(max_workers=2) as workers:
            futures = [workers.submit(run, ['python3', '-B', str(script), *args], timeout)
                       for script, args, timeout in jobs]
            for future in futures:
                future.result()
        run(['python3', '-B', str(ROOT / 'scripts/count-sloc.py')])
        summary['sources_after'] = sources()
        assert summary['sources_before'] == summary['sources_after'], 'sources changed during verification'
        assert digest(CLI) == summary['binary']['sha256']
        assert host_guard() == summary['host_fixture']
        summary['status'] = 'normal migration and prepared publication verification passed'
        print('PASS normal graph adoption; ordinary demo integration remains separate', flush=True)
    except BaseException as error:
        summary.update(status='failed', failure=repr(error))
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
