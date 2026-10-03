#!/usr/bin/env python3
"""ETAS-0013 exact merged-fix graph, separate from both accepted Nomo graphs."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path('/validation')
REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('graph', Path(__file__).with_name('etas-013-isolated.py'))
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)
REVISIONS = {
    'core': '198c362a937139b50c4484ae2cf7a4819a9df714',
    'frontend': '7b1974b95c64e7833779ee1eda5ec73c4374b4fe',
    'interpreter': 'd8e7ecaf8f5a234dea48ef887a20d829ccdc401e',
    'cli': '8c156adb04812307bf34bfba9d4faa277957b3d2',
}


def configure(prepare=False):
    GRAPH.environment_guard()
    if prepare:
        assert not (ROOT / 'identity.json').exists(), 'refuse to replace an existing graph'
    identity = None if prepare else json.loads((ROOT / 'identity.json').read_text())
    pins = {}
    for name, (repository, _, _, packages) in GRAPH.PINS.items():
        revision = REVISIONS[name]
        path = ROOT / name
        if prepare:
            assert not path.exists(), ('fresh checkout required', path)
            path.mkdir()
            GRAPH.run(['git', 'init', '-q', str(path)])
            GRAPH.run(['git', 'fetch', '--depth', '1',
                       f'https://github.com/etas-project/{repository}.git', revision], cwd=path)
            GRAPH.run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'], cwd=path)
            assert GRAPH.run(['git', 'rev-parse', 'HEAD'], cwd=path).strip() == revision
            tree = GRAPH.run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=path).strip()
        else:
            actual = identity['pins'][name]
            assert actual[0] == repository and actual[1] == revision and actual[3] == packages
            tree = actual[2]
        assert len(tree) == 40 and all(c in '0123456789abcdef' for c in tree), 'invalid retained tree'
        pins[name] = (repository, revision, tree, packages)
    GRAPH.PINS = pins


def host_fixture():
    fixture = ROOT / 'host-faults'
    assert not fixture.exists(), 'refuse to overwrite existing fixture source'
    shutil.copytree(REPO / 'tests/fixtures/session_store/host_faults', fixture)
    manifest = (fixture / 'Cargo.toml').read_text()
    old_pins = ('375a6a088eca4df2d0accf4d8c9550901721b1e3',
                '59b2115de2ca7c33b5c5743f4113fa51eb3eb69e',
                '481ff62c895978853bc7385d76c1a799a5f780b1')
    for name, old in zip(('core', 'frontend', 'interpreter'), old_pins):
        assert old in manifest
        manifest = manifest.replace(old, REVISIONS[name])
    (fixture / 'Cargo.toml').write_text(manifest)
    shutil.copyfile(ROOT / 'cli/Cargo.lock', fixture / 'Cargo.lock')
    metadata = json.loads(GRAPH.run(['cargo', 'metadata', '--offline', '--format-version', '1',
        '--manifest-path', str(fixture / 'Cargo.toml'), '--config', str(ROOT / 'cli-overrides.toml')]))
    expected = {p: str(ROOT / n / 'crates' / p / 'Cargo.toml')
                for n, (_, _, _, packages) in GRAPH.PINS.items() if n != 'cli' for p in packages.split()}
    origins = {}
    approved = {(p['name'], p['version'], p['source'])
                for p in json.loads((ROOT / 'cli-metadata.json').read_text())['packages']}
    for package in metadata['packages']:
        name = package['name']
        if name == 'nomo-session-store-host-faults':
            continue
        assert (name, package['version'], package['source']) in approved, package
        if name.startswith('etas_'):
            assert name not in origins and package['source'] is None
            assert package['manifest_path'] == expected[name]
            origins[name] = package['manifest_path']
    assert origins == expected
    GRAPH.save('host-faults-metadata.json', metadata)
    GRAPH.save('host-faults-origins.json', origins)
    GRAPH.run(['cargo', 'build', '--offline', '--locked', '--manifest-path', str(fixture / 'Cargo.toml'),
               '--config', str(ROOT / 'cli-overrides.toml')], timeout=1200)
    GRAPH.save('host-faults-identity.json', {
        'fixture_lock_sha256': GRAPH.digest(fixture / 'Cargo.lock'),
        'fixture_source_sha256': {p: GRAPH.digest(fixture / p) for p in ['Cargo.toml', 'src/main.rs', 'setup.es']},
        'fixture_binary_sha256': GRAPH.digest(ROOT / 'target/debug/nomo-session-store-host-faults'),
        'fixed_revisions': REVISIONS,
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'guard', 'build', 'fixture', 'verify'])
    options = parser.parse_args()
    configure(options.mode == 'prepare')
    if options.mode == 'prepare':
        GRAPH.prepare()
        GRAPH.save('fresh-fixed-graph.json', {'task': 'ETAS-0013-VERIFY', 'revisions': REVISIONS,
            'resolution': 'fresh isolated resolution, not normal or storage graph migration',
            'setup_script_sha256': GRAPH.digest(Path(__file__))})
        return
    GRAPH.guard()
    if options.mode == 'build':
        GRAPH.cargo('cli', 'build', '--offline', '--locked', '-p', 'etas_cli', '--all-features', timeout=1200)
        binary = {'sha256': GRAPH.digest(ROOT / 'target/debug/etas'),
                  'version': GRAPH.run([str(ROOT / 'target/debug/etas'), '--version'])}
        if (ROOT / 'binary.json').exists():
            assert binary == json.loads((ROOT / 'binary.json').read_text())
            GRAPH.save('cached-build.json', binary)
        else:
            GRAPH.save('binary.json', binary)
    elif options.mode == 'fixture':
        host_fixture()
    elif options.mode == 'verify':
        print(GRAPH.run(['python3', '-B', str(REPO / 'tests/etas0013_fixed_probe.py')], timeout=900), end='')


if __name__ == '__main__':
    main()
