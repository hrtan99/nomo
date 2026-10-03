#!/usr/bin/env python3
"""Build a test-only pre-dispatch fault observer without changing the normal graph.

The base Host remains byte-identical. One uniquely matched insertion skips the
second Memory mutation before SQLite dispatch and returns a transport failure.
This is not committed acknowledgement loss and does not fabricate WriteOutcome.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
GRAPH = Path(os.environ.get('SESSION_STORE_GRAPH', '/home/nomo/.cargo/etas0013'))
EVIDENCE = Path(os.environ.get('NOMO_TEST_EVIDENCE', '/evidence'))
ANCHOR = '            let response = self.memory.write_scoped(request, &operation).await?;'
FAULT_ARGUMENTS = '"stale-pending", "publish-readback", "reload-changed"].contains'
INSERT = '''            if self.fault == "publish-before-dispatch" && ordinal == 2 {
                assert!(!self.fault_fired.swap(true, Ordering::SeqCst));
                self.trace.lock().unwrap().push(json!({
                    "kind":"memory", "ordinal":ordinal, "actual_sqlite_commit":false,
                    "dispatched":false, "provider_unavailable_before_dispatch":true
                }));
                return Err(HostError::new(HostErrorCode::ProviderUnavailable,
                    "test provider unavailable before SQLite dispatch; no commit"));
            }
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    assert EVIDENCE.is_dir() and not EVIDENCE.resolve().is_relative_to(GRAPH.resolve())
    assert Path.cwd().resolve() == ROOT.resolve(), 'run from the checked repository root'
    mounts = Path('/proc/self/mountinfo').read_text().splitlines()
    cache_mount = next(line for line in mounts if line.split()[4] == '/home/nomo/.cargo')
    assert 'ro' in cache_mount.split()[5].split(','), 'normal Cargo cache must be mounted read-only'
    bootstrap_path = ROOT / 'scripts/etas-0013-cli-bootstrap.py'
    specification = importlib.util.spec_from_file_location('normal_bootstrap', bootstrap_path)
    bootstrap = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(bootstrap)
    assert GRAPH == bootstrap.ROOT
    verified_cli = bootstrap.verify(read_only=True)
    base_identity = json.loads((GRAPH / 'host-faults-identity.json').read_text())
    base = ROOT / 'tests/fixtures/session_store/host_faults'
    assert {name: digest(base / name) for name in base_identity['fixture_source_sha256']} == base_identity['fixture_source_sha256']
    assert digest(GRAPH / 'host-faults/Cargo.lock') == base_identity['fixture_lock_sha256']
    protected = {str(path): digest(path) for path in (
        GRAPH / 'identity.json', GRAPH / 'binary.json', GRAPH / 'target/debug/nomo-session-store-host-faults',
        GRAPH / 'host-faults/Cargo.lock', *(GRAPH / 'src' / component / 'Cargo.lock' for component in ('core', 'frontend', 'interpreter', 'cli')))}
    directory = Path(tempfile.mkdtemp(prefix='session-demo-host-build-', dir=EVIDENCE))
    print('EVIDENCE ' + str(directory), flush=True)
    fixture = directory / 'host-faults'
    shutil.copytree(base, fixture)
    shutil.copyfile(GRAPH / 'host-faults/Cargo.lock', fixture / 'Cargo.lock')
    source = fixture / 'src/main.rs'
    original = source.read_text()
    assert original.count(ANCHOR) == original.count(FAULT_ARGUMENTS) == 1 and 'publish-before-dispatch' not in original
    (directory / 'original-main.rs').write_text(original)
    source.write_text(original.replace(ANCHOR, INSERT + ANCHOR).replace(
        FAULT_ARGUMENTS, '"stale-pending", "publish-readback", "reload-changed", "publish-before-dispatch"].contains'))
    shutil.copyfile(Path(__file__), directory / 'build_driver.py')
    shutil.copyfile(bootstrap_path, directory / 'normal_bootstrap.py')
    build_env = dict(os.environ, CARGO_TARGET_DIR=str(directory / 'target'))
    report = {'base_identity': base_identity, 'protected_graph': protected,
              'base_source_sha256': digest(directory / 'original-main.rs'),
              'generated_source_sha256': digest(source), 'recipe_sha256': digest(directory / 'build_driver.py'),
              'transformation': 'unique pre-dispatch insertion plus exact CLI fault allow-list addition; no product changes',
              'verified_cli': verified_cli, 'bootstrap_sha256': digest(directory / 'normal_bootstrap.py'),
              'checked_cwd': str(ROOT), 'cache_mount': cache_mount,
              'cargo_home': build_env.get('CARGO_HOME'), 'cargo_target_dir': build_env['CARGO_TARGET_DIR'],
              'commands': []}

    def run(arguments):
        item = {'command': list(map(str, arguments))}
        report['commands'].append(item)
        process = subprocess.run(arguments, cwd=ROOT, env=build_env, text=True, capture_output=True, timeout=1200)
        item.update(exit=process.returncode, stdout=process.stdout, stderr=process.stderr)
        (directory / 'build-results.json').write_text(json.dumps(report, indent=2))
        assert process.returncode == 0, item
        return process.stdout

    common = ['--offline', '--locked', '--manifest-path', str(fixture / 'Cargo.toml'), '--config', str(GRAPH / 'cli-overrides.toml')]
    metadata = json.loads(run(['cargo', 'metadata', '--format-version', '1', *common]))
    approved = {(p['name'], p['version'], p['source']) for p in json.loads((GRAPH / 'cli-metadata.json').read_text())['packages']}
    expected_origins = json.loads((GRAPH / 'host-faults-origins.json').read_text())
    origins = {}
    for package in metadata['packages']:
        if package['name'] == 'nomo-session-store-host-faults':
            assert package['manifest_path'] == str(fixture / 'Cargo.toml')
            continue
        assert (package['name'], package['version'], package['source']) in approved, package
        if package['name'].startswith('etas_'):
            assert package['source'] is None and package['name'] not in origins
            origins[package['name']] = package['manifest_path']
    assert origins == expected_origins, origins
    (directory / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    (directory / 'origins.json').write_text(json.dumps(origins, indent=2))
    run(['cargo', 'build', *common])
    binary = directory / 'target/debug/nomo-session-store-host-faults'
    assert digest(fixture / 'Cargo.lock') == base_identity['fixture_lock_sha256']
    assert {name: digest(Path(name)) for name in protected} == protected
    assert {name: digest(base / name) for name in base_identity['fixture_source_sha256']} == base_identity['fixture_source_sha256']
    assert digest(bootstrap_path) == digest(directory / 'normal_bootstrap.py')
    identity = {'base_identity': base_identity, 'fixture_binary': str(binary), 'fixture_binary_sha256': digest(binary),
                'fixture_lock_sha256': digest(fixture / 'Cargo.lock'),
                'fixture_source_root': str(fixture),
                'fixture_source_sha256': {name: digest(fixture / name) for name in base_identity['fixture_source_sha256']},
                'recipe_sha256': digest(directory / 'build_driver.py'), 'metadata_sha256': digest(directory / 'metadata.json'),
                'origins_sha256': digest(directory / 'origins.json'), 'added_fault': 'publish-before-dispatch',
                'bootstrap_sha256': digest(directory / 'normal_bootstrap.py'), 'verified_cli': verified_cli}
    (directory / 'identity.json').write_text(json.dumps(identity, indent=2))
    print('PASS demo-only observer ' + str(directory / 'identity.json'), flush=True)


if __name__ == '__main__':
    main()
