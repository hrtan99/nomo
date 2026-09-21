#!/usr/bin/env python3
"""ETAS-013 disposable engineering graph; never installs into the accepted cache."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path('/validation')
PINS = {
    'core': ('etas-core', '375a6a088eca4df2d0accf4d8c9550901721b1e3',
             '3962556e64620eb569f229b2cc03f1b3df76a276',
             'etas_builtin etas_cache etas_core etas_host etas_package_metadata etas_std etas_utils'),
    'frontend': ('etas-frontend', '59b2115de2ca7c33b5c5743f4113fa51eb3eb69e',
                 '135ce04dc53d56fb9e9424457b7201c81151c275',
                 'etas_syntax etas_hir etas_hir_analysis etas_types etas_effects etas_frontend'),
    'interpreter': ('etas-interpreter', '481ff62c895978853bc7385d76c1a799a5f780b1',
                    'a61f73ea4d13c8db7f80129b776d9db9cd77901b', 'etas_interpreter'),
    'cli': ('etas', '8c156adb04812307bf34bfba9d4faa277957b3d2',
            '00f2bc7cc1b58da137c898788a784e6d7a301da4',
            'etas_cli etas_driver etas_package etas_tests'),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, *, cwd=ROOT, timeout=600):
    print('+', ' '.join(map(str, args)), flush=True)
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    logs = ROOT / 'logs'
    logs.mkdir(exist_ok=True)
    (logs / f'{time.time_ns()}.log').write_text(
        '+ ' + ' '.join(map(str, args)) + f'\nexit={result.returncode}\n' + result.stdout
        + '\nSTDERR\n' + result.stderr)
    if result.stderr:
        print(result.stderr, end='', flush=True)
    result.check_returncode()
    return result.stdout


def save(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def source_guard():
    for name, (_, revision, tree, _) in PINS.items():
        path = ROOT / name
        assert run(['git', 'rev-parse', 'HEAD'], cwd=path).strip() == revision
        assert run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=path).strip() == tree
        # The core repository tracks a lock; only this disposable lock may differ.
        assert not run(['git', 'diff', 'HEAD', '--', '.', ':(exclude)Cargo.lock'], cwd=path).strip()
        assert not run(['git', 'diff', '--cached', 'HEAD', '--'], cwd=path).strip()
        extra = run(['git', 'ls-files', '--others', '--exclude-standard'], cwd=path).splitlines()
        assert set(extra) <= {'Cargo.lock'}, (name, extra)


def config_text(workspace):
    lines = []
    upstreams = list(PINS)[:list(PINS).index(workspace)]
    for name, (repo, _, _, packages) in PINS.items():
        if name not in upstreams:
            continue
        lines.append(f'[patch."https://github.com/etas-project/{repo}.git"]')
        for package in packages.split():
            lines.append(f'{package} = {{ path = "/validation/{name}/crates/{package}" }}')
    return '\n'.join(lines) + '\n'


def cargo(name, *args, timeout=900):
    return run(['cargo', *args, '--manifest-path', str(ROOT / name / 'Cargo.toml'),
                '--config', str(ROOT / f'{name}-overrides.toml')], timeout=timeout)


def graph(name, offline):
    data = json.loads(cargo(name, 'metadata', '--format-version', '1', '--all-features',
                            *(['--offline', '--locked'] if offline else [])))
    expected = {p: str(ROOT / n / 'crates' / p / 'Cargo.toml')
                for n, (_, _, _, packages) in PINS.items() for p in packages.split()}
    origins = {}
    for package in data['packages']:
        if package['name'].startswith('etas_'):
            key = package['name']
            assert key not in origins, ('duplicate Etas package', key)
            assert package['source'] is None, ('unmapped Etas source', package)
            assert package['manifest_path'] == expected[key], package
            origins[key] = package['manifest_path']
    assert origins, 'empty Etas graph'
    if name == 'cli':
        assert set(origins) == set(expected), (set(origins), set(expected))
    save(f'{name}-metadata.json', data)
    save(f'{name}-origins.json', origins)
    return digest(ROOT / name / 'Cargo.lock')


def prepare():
    assert not (ROOT / 'identity.json').exists(), 'refuse to replace a prepared graph'
    for name, (repo, revision, _, _) in PINS.items():
        path = ROOT / name
        if path.exists():
            assert run(['git', 'rev-parse', 'HEAD'], cwd=path).strip() == revision
            continue
        path.mkdir()
        print(run(['git', 'init', '-q', str(path)]), end='')
        print(run(['git', 'fetch', '--depth', '1',
                   f'https://github.com/etas-project/{repo}.git', revision], cwd=path), end='')
        print(run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'],
                  cwd=path), end='')
    source_guard()
    for name in PINS:
        (ROOT / f'{name}-overrides.toml').write_text(config_text(name))
    locks = {}
    for name in PINS:
        # Resolve the disposable lock with the complete feature set exactly once.
        locks[name] = graph(name, False)
        print(cargo(name, 'fetch', '--locked'), end='')
    save('identity.json', {'pins': PINS, 'locks': locks,
                          'overrides': {n: digest(ROOT / f'{n}-overrides.toml') for n in PINS},
                          'rustc': run(['rustc', '-vV']), 'cargo': run(['cargo', '-V'])})
    print('Prepared all four locked graphs; no installation performed.')


def guard():
    environment_guard()
    source_guard()
    identity = json.loads((ROOT / 'identity.json').read_text())
    assert identity['pins'] == json.loads(json.dumps(PINS))
    assert run(['rustc', '-vV']) == identity['rustc']
    assert run(['cargo', '-V']) == identity['cargo']
    for name in PINS:
        assert (ROOT / f'{name}-overrides.toml').read_text() == config_text(name)
        assert digest(ROOT / f'{name}-overrides.toml') == identity['overrides'][name]
        assert digest(ROOT / name / 'Cargo.lock') == identity['locks'][name]
        assert graph(name, True) == identity['locks'][name]
    print('PASS exact sources, override config, locks and all transitive Etas origins')


def environment_guard():
    assert ROOT.is_dir() and ROOT.resolve() == ROOT
    assert os.environ.get('CARGO_HOME') == '/validation/cargo'
    assert os.environ.get('XDG_CACHE_HOME') == '/validation/frontend-cache'
    assert os.environ.get('CARGO_TARGET_DIR') == '/validation/target'
    for path in ['/validation/.cargo/config', '/validation/.cargo/config.toml',
                 '/validation/cargo/config', '/validation/cargo/config.toml',
                 '/.cargo/config', '/.cargo/config.toml']:
        assert not Path(path).exists(), ('unexpected Cargo config', path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'guard', 'build'])
    args = parser.parse_args()
    environment_guard()
    if args.mode == 'prepare':
        prepare()
    else:
        guard()
        if args.mode == 'build':
            previous = json.loads((ROOT / 'binary.json').read_text()) if (ROOT / 'binary.json').exists() else None
            print(cargo('cli', 'build', '--offline', '--locked', '-p', 'etas_cli',
                        '--all-features', timeout=1200), end='')
            current = {'sha256': digest(ROOT / 'target/debug/etas'),
                       'version': run([str(ROOT / 'target/debug/etas'), '--version'])}
            if previous:
                assert current == previous, ('cached build drift', previous, current)
                save('cached-build.json', current)
            else:
                save('binary.json', current)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stdout, flush=True)
        raise
