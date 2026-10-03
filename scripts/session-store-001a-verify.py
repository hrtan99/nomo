#!/usr/bin/env python3
"""Verify the isolated storage package without resolving, building or normal migration."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
BASE = Path('/validation')
CLI = BASE / 'target/debug/etas'
SPEC = importlib.util.spec_from_file_location('store_graph', ROOT / 'scripts/etas-013-isolated.py')
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)
PROBES = ['session_store_codec_probe.py', 'session_store_probe.py',
          'session_store_bounds_probe.py', 'session_store_fault_probe.py',
          'test_sloc_counter.py', 'session_store_match_probe.py']
ACCEPTED_COMMAND = ('docker compose -f compose.yaml -f tests/fixtures/tool001a/compose.yaml run '
                    '--rm --no-deps --tty=false --env PYTHONDONTWRITEBYTECODE=1 '
                    'dev python3 /workspace/scripts/session-001a-verify.py')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def origins(metadata):
    expected = {p: str(BASE / name / 'crates' / p / 'Cargo.toml')
                for name, (_, _, _, packages) in GRAPH.PINS.items() for p in packages.split()}
    result = {}
    for package in metadata['packages']:
        name = package['name']
        if name.startswith('etas_'):
            assert name not in result, ('duplicate Etas origin', name)
            assert package['source'] is None, ('nonlocal Etas origin', name)
            assert package['manifest_path'] == expected[name], ('wrong Etas origin', name)
            result[name] = package['manifest_path']
    assert result, 'missing Etas origins'
    return result


def guard(run):
    GRAPH.environment_guard()
    identity = read(BASE / 'identity.json')
    assert identity['pins'] == json.loads(json.dumps(GRAPH.PINS)), 'source pin identity mismatch'
    # Reuse the existing exact HEAD/tree/clean-source guard; log reads in this run.
    GRAPH.run = lambda args, cwd=BASE, timeout=600: run(args, cwd=cwd, timeout=timeout).stdout
    GRAPH.source_guard()
    assert run(['rustc', '-vV']).stdout == identity['rustc']
    assert run(['cargo', '-V']).stdout == identity['cargo']
    for name in GRAPH.PINS:
        override = BASE / f'{name}-overrides.toml'
        assert override.read_text() == GRAPH.config_text(name), ('override text', name)
        assert digest(override) == identity['overrides'][name], ('override hash', name)
        assert digest(BASE / name / 'Cargo.lock') == identity['locks'][name], ('lock hash', name)
        actual = origins(read(BASE / f'{name}-metadata.json'))
        assert actual == read(BASE / f'{name}-origins.json'), ('recorded origins', name)
    expected = {p for _, _, _, packages in GRAPH.PINS.values() for p in packages.split()}
    cli_metadata = read(BASE / 'cli-metadata.json')
    assert set(origins(cli_metadata)) == expected, 'incomplete CLI origin mapping'
    binary = read(BASE / 'binary.json')
    assert binary == read(BASE / 'cached-build.json'), 'cached CLI identity mismatch'
    assert digest(CLI) == binary['sha256'], 'CLI binary mismatch'
    assert run([str(CLI), '--version']).stdout == binary['version']
    host = read(BASE / 'host-faults-identity.json')
    assert host['cli_identity_sha256'] == digest(BASE / 'identity.json')
    assert host['normal_four_locks_preserved'] == identity['locks']
    assert host['cli_binary_preserved'] == binary['sha256']
    assert digest(BASE / 'target/debug/nomo-session-store-host-faults') == host['fixture_binary_sha256']
    assert digest(BASE / 'host-faults/Cargo.lock') == host['fixture_lock_sha256']
    for name, fingerprint in host['fixture_source_sha256'].items():
        assert digest(ROOT / 'tests/fixtures/session_store/host_faults' / name) == fingerprint
        assert digest(BASE / 'host-faults' / name) == fingerprint
    metadata = read(BASE / 'host-faults-metadata.json')
    host_origins = origins(metadata)
    assert host_origins == read(BASE / 'host-faults-origins.json')
    expected_host = {p for name, (_, _, _, packages) in GRAPH.PINS.items()
                     if name != 'cli' for p in packages.split()}
    assert set(host_origins) == expected_host, 'incomplete Host fixture origin mapping'
    approved = {(p['name'], p['version'], p['source']) for p in cli_metadata['packages']}
    assert all((p['name'], p['version'], p['source']) in approved for p in metadata['packages']
               if p['name'] != 'nomo-session-store-host-faults'), 'fixture dependency drift'
    return {'graph': identity, 'binary': binary, 'host_fixture': host}


def source_hashes():
    paths = [ROOT / 'tests' / name for name in PROBES]
    paths += [ROOT / name for name in ['etas.toml', 'etas.lock', 'compose.yaml',
              'tests/fixtures/etas013/compose.yaml', 'tests/session_state_probe.py',
              'tests/tool_workspace_probe.py', 'scripts/etas-013-isolated.py',
              'scripts/count-sloc.py', 'scripts/session-store-001a-verify.py']]
    paths += list((ROOT / 'src').rglob('*.es'))
    paths += list((ROOT / 'packages/session-store/src').rglob('*.es'))
    paths += [ROOT / 'tests/fixtures/session_store/host_faults' / name
              for name in ['Cargo.toml', 'src/main.rs', 'setup.es']]
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(set(paths))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--guard-only', action='store_true', help='validate retained provenance only; not a test pass')
    options = parser.parse_args()
    assert BASE.is_dir() and BASE.resolve() == BASE, 'required /validation graph missing'
    evidence = Path(tempfile.mkdtemp(prefix='session-store-verification-', dir=BASE))
    scratch = evidence / 'scratch'
    scratch.mkdir()
    print('EVIDENCE ' + str(evidence), flush=True)
    summary = {'environment': 'fresh isolated four-pin SESSION-STORE-GRAPH-001, not accepted ETAS-011',
               'status': 'running', 'guard_only': options.guard_only, 'commands': [],
               'accepted_regression': {'status': 'not run by this isolated runner', 'command': ACCEPTED_COMMAND}}

    def save():
        (evidence / 'results.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False))

    def run(command, *, cwd=ROOT, timeout=180, expected=0):
        print('+ ' + ' '.join(map(str, command)), flush=True)
        env = dict(os.environ, ETAS=str(CLI), SESSION_STORE_GRAPH=str(BASE),
                   TMPDIR=str(scratch), PYTHONDONTWRITEBYTECODE='1')
        item = {'command': list(map(str, command)), 'cwd': str(cwd), 'timeout': timeout,
                'expected_exit': expected, 'environment': summary['environment']}
        summary['commands'].append(item)
        save()
        try:
            result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            item.update({'timeout_expired': True, 'stdout': str(error.stdout or ''), 'stderr': str(error.stderr or '')})
            save()
            raise
        item.update({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
        save()
        if result.stdout:
            print(result.stdout, end='', flush=True)
        if result.stderr:
            print(result.stderr, end='', file=sys.stderr, flush=True)
        assert result.returncode == expected, ('unexpected exit', item)
        return result

    try:
        summary['provenance'] = guard(run)
        summary['sources_before'] = source_hashes()
        save()
        if options.guard_only:
            summary['status'] = 'guard passed; tests not run'
            return
        sys.path.insert(0, str(ROOT / 'tests'))
        from session_store_probe import fixture_source, materialize
        project = evidence / 'phase-check'
        source = materialize(project)
        source.write_text(fixture_source('stub'))
        summary['phase_source_sha256'] = digest(source)
        run([str(CLI), 'check', str(project)])
        run([str(CLI), 'check', '--all', str(project)])
        phase = run([str(CLI), 'check', '--phase1', str(project)], expected=1)
        assert 'RuntimeRequiredInPhase1' in phase.stderr and 'error[' not in phase.stderr, phase.stderr
        jobs = [(PROBES[0], [], 300), (PROBES[1], [], 360),
                (PROBES[1], ['--negative-only'], 600), (PROBES[2], [], 600),
                (PROBES[3], [], 900), (PROBES[4], [], 60), (PROBES[5], [], 300)]
        for script, args, timeout in jobs:
            run(['python3', '-B', str(ROOT / 'tests' / script), *args], timeout=timeout)
        run(['python3', '-B', str(ROOT / 'scripts/count-sloc.py')])
        summary['sources_after'] = source_hashes()
        assert summary['sources_before'] == summary['sources_after'], 'source changed during verification'
        assert digest(CLI) == summary['provenance']['binary']['sha256'], 'CLI changed during verification'
        summary['status'] = 'isolated verification passed'
        print('PASS isolated storage verification; accepted-graph regressions remain separately labelled', flush=True)
        print('ACCEPTED-GRAPH COMMAND (not executed): ' + ACCEPTED_COMMAND, flush=True)
    except BaseException as error:
        summary['status'] = 'failed'
        summary['failure'] = repr(error)
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
