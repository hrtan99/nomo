#!/usr/bin/env python3
"""Normal ETAS-0013 bootstrap: exact sources/locks, new cache, offline build."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

REPO = Path(__file__).resolve().parent.parent
CACHE = Path('/home/nomo/.cargo')
ROOT = CACHE / 'etas0013'
SOURCE = ROOT / 'src'
INSTALLED = CACHE / 'bin/etas'
PINS = {
    'core': ('etas-core', '198c362a937139b50c4484ae2cf7a4819a9df714',
             'b5eb0f6a0bbb98cdb3ac6903bf55caaff31c7022',
             'etas_builtin etas_cache etas_core etas_host etas_package_metadata etas_std etas_utils'),
    'frontend': ('etas-frontend', '7b1974b95c64e7833779ee1eda5ec73c4374b4fe',
                 '241e0f8795360251377475bb3a858a1b5476ea74',
                 'etas_syntax etas_hir etas_hir_analysis etas_types etas_effects etas_frontend'),
    'interpreter': ('etas-interpreter', 'd8e7ecaf8f5a234dea48ef887a20d829ccdc401e',
                    '16e49daf7f61f19649ee4e9ce5599264d079e9ff', 'etas_interpreter'),
    'cli': ('etas', '8c156adb04812307bf34bfba9d4faa277957b3d2',
            '00f2bc7cc1b58da137c898788a784e6d7a301da4',
            'etas_cli etas_driver etas_package etas_tests'),
}
LOCKS = {
    'core': '9d0731d8ba1838cde19f3b9b6ffe465b9869ee18e26aedcff01981bddc886c48',
    'frontend': '17c75ae642a7434ad323c922e7a185a20c6a57fd8cf5a89481de50205f071133',
    'interpreter': '6d32460a735f29a3b70f3bc4fe004deacdcd4df58ee7ff4850f20a4fc91ab915',
    'cli': '9cb5fb388cac6a061dcd8393b32dc342346ecd6323b5ec9153239d1895379b81',
}


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def run(args, *, cwd=ROOT, timeout=1200):
    print('+', ' '.join(map(str, args)), flush=True)
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    logs = ROOT / 'logs'
    logs.mkdir(exist_ok=True)
    (logs / f'{time.time_ns()}.log').write_text('+ ' + ' '.join(map(str, args))
        + f'\nexit={result.returncode}\n' + result.stdout + '\nSTDERR\n' + result.stderr)
    if result.stderr:
        print(result.stderr, end='', flush=True)
    result.check_returncode()
    return result.stdout


def environment_guard():
    require(platform.system() == 'Linux' and platform.machine() == 'aarch64', 'Linux/arm64 Docker required')
    require(os.environ.get('CARGO_HOME') == str(CACHE), 'unexpected CARGO_HOME')
    require(os.environ.get('CARGO_TARGET_DIR') == str(ROOT / 'target'), 'unexpected CARGO_TARGET_DIR')
    require(CACHE.resolve() == CACHE and ROOT.resolve() == ROOT, 'symlinked cache root')
    allowed = {'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'CARGO_TERM_COLOR'}
    forbidden = [key for key in os.environ if key.startswith('CARGO_') and key not in allowed]
    forbidden += [key for key in ('RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC', 'RUSTDOC',
                  'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER') if key in os.environ]
    require(not forbidden, f'unapproved Cargo/Rust overrides: {forbidden}')
    config_dirs = [directory / '.cargo' for directory in
                   (Path('/'), Path('/home'), Path('/home/nomo'), REPO, ROOT, SOURCE, CACHE)]
    for config_dir in [CACHE, *config_dirs]:
        for filename in ('config', 'config.toml'):
            require(not (config_dir / filename).exists(), f'unexpected Cargo config: {config_dir / filename}')
    for name, expected in LOCKS.items():
        require(digest(REPO / 'patches/etas-0013' / f'{name}.Cargo.lock') == expected,
                f'distributed lock drift: {name}')


def config_text(workspace):
    lines = []
    for name in list(PINS)[:list(PINS).index(workspace)]:
        repo, _, _, packages = PINS[name]
        lines.append(f'[patch."https://github.com/etas-project/{repo}.git"]')
        lines.extend(f'{package} = {{ path = "{SOURCE / name / "crates" / package}" }}'
                     for package in packages.split())
    return '\n'.join(lines) + '\n'


def read(args, *, cwd=ROOT):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True).stdout


def source_guard(command=run):
    for name, (repository, revision, tree, _) in PINS.items():
        path = SOURCE / name
        require(path.resolve() == path, f'symlinked source: {name}')
        require(command(['git', 'remote', 'get-url', 'origin'], cwd=path).strip()
                == f'https://github.com/etas-project/{repository}.git', f'origin drift: {name}')
        require(command(['git', 'rev-parse', 'HEAD'], cwd=path).strip() == revision, f'HEAD drift: {name}')
        require(command(['git', 'rev-parse', 'HEAD^{tree}'], cwd=path).strip() == tree, f'tree drift: {name}')
        require(not command(['git', 'diff', 'HEAD', '--', '.', ':(exclude)Cargo.lock'], cwd=path).strip(),
                f'source drift: {name}')
        require(not command(['git', 'diff', '--cached', 'HEAD', '--'], cwd=path).strip(), f'index drift: {name}')
        extras = command(['git', 'ls-files', '--others', '--exclude-standard'], cwd=path).splitlines()
        require(set(extras) <= {'Cargo.lock'}, f'extra source files: {name}: {extras}')
        require(digest(path / 'Cargo.lock') == LOCKS[name], f'lock drift: {name}')


def cargo(name, *args, timeout=1200):
    return run(['cargo', *args, '--manifest-path', str(SOURCE / name / 'Cargo.toml'),
                '--config', str(ROOT / f'{name}-overrides.toml')], timeout=timeout)


def graph(name, *, offline=True):
    data = json.loads(cargo(name, 'metadata', '--format-version', '1', '--all-features',
                            '--locked', *(['--offline'] if offline else [])))
    return data, metadata_origins(name, data)


def metadata_origins(name, data):
    expected = {p: str(SOURCE / n / 'crates' / p / 'Cargo.toml')
                for n in list(PINS)[:list(PINS).index(name) + 1] for p in PINS[n][3].split()}
    origins = {}
    for package in data['packages']:
        key = package['name']
        if key.startswith('etas_'):
            require(key not in origins and package['source'] is None, f'mixed Etas origin: {key}')
            require(package['manifest_path'] == expected.get(key), f'wrong Etas path: {package}')
            origins[key] = package['manifest_path']
    require(origins and (name != 'cli' or origins == expected), f'incomplete Etas graph: {name}')
    return origins


def prepare():
    environment_guard()
    if (ROOT / 'identity.json').exists():
        guard()
        print('Already prepared; exact retained graph verified.')
        return
    marker = {'task': 'ETAS-ADOPT-0013', 'pins': json.loads(json.dumps(PINS)), 'locks': LOCKS}
    if ROOT.exists():
        require(json.loads((ROOT / 'bootstrap-owner.json').read_text()) == marker, 'unowned cache root')
    else:
        require(not INSTALLED.exists(), 'refuse pre-existing installed CLI in new cache')
        ROOT.mkdir()
        save('bootstrap-owner.json', marker)
    SOURCE.mkdir(exist_ok=True)
    for name, (repository, revision, _, _) in PINS.items():
        path = SOURCE / name
        if not path.exists():
            path.mkdir()
            run(['git', 'init', '-q', str(path)])
            run(['git', 'remote', 'add', 'origin', f'https://github.com/etas-project/{repository}.git'], cwd=path)
            run(['git', 'fetch', '--depth', '1', 'origin', revision], cwd=path)
            run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'], cwd=path)
            shutil.copyfile(REPO / 'patches/etas-0013' / f'{name}.Cargo.lock', path / 'Cargo.lock')
        config = ROOT / f'{name}-overrides.toml'
        if config.exists():
            require(config.read_text() == config_text(name), f'override drift: {name}')
        else:
            config.write_text(config_text(name))
    source_guard()
    for name in PINS:
        cargo(name, 'fetch', '--locked')
        data, origins = graph(name)
        save(f'{name}-metadata.json', data)
        save(f'{name}-origins.json', origins)
    save('identity.json', {'pins': PINS, 'locks': LOCKS,
        'overrides': {n: digest(ROOT / f'{n}-overrides.toml') for n in PINS},
        'metadata': {n: digest(ROOT / f'{n}-metadata.json') for n in PINS},
        'rustc': run(['rustc', '-vV']), 'cargo': run(['cargo', '-V']),
        'bootstrap_sha256': digest(Path(__file__)), 'source_root': str(SOURCE)})
    print('PASS prepared exact locked normal graph; no binary installed')


def guard(read_only=False):
    environment_guard()
    command = read if read_only else run
    identity = json.loads((ROOT / 'identity.json').read_text())
    require(identity['pins'] == json.loads(json.dumps(PINS)) and identity['locks'] == LOCKS,
            'retained graph identity drift')
    require(command(['rustc', '-vV']) == identity['rustc'] and command(['cargo', '-V']) == identity['cargo'],
            'toolchain drift')
    source_guard(command)
    for name in PINS:
        config = ROOT / f'{name}-overrides.toml'
        require(config.read_text() == config_text(name) and digest(config) == identity['overrides'][name],
                f'override identity drift: {name}')
        metadata = ROOT / f'{name}-metadata.json'
        require(digest(metadata) == identity['metadata'][name], f'retained metadata drift: {name}')
        if read_only:
            data = json.loads(metadata.read_text())
            origins = metadata_origins(name, data)
        else:
            data, origins = graph(name)
        require(origins == json.loads((ROOT / f'{name}-origins.json').read_text()), f'origin drift: {name}')
        require(data == json.loads((ROOT / f'{name}-metadata.json').read_text()), f'metadata drift: {name}')
    print('PASS exact HEAD/tree, local origins, distributed locks, configuration and toolchain')


def build():
    guard()
    cargo('cli', 'build', '--offline', '--locked', '--release', '-p', 'etas_cli', '--all-features', timeout=3600)
    binary = ROOT / 'target/release/etas'
    current = {'sha256': digest(binary), 'version': run([str(binary), '--version'])}
    if (ROOT / 'binary.json').exists():
        require(current == json.loads((ROOT / 'binary.json').read_text()), 'cached build binary drift')
        require(INSTALLED.exists() and digest(INSTALLED) == current['sha256'], 'installed CLI drift')
    else:
        require(not INSTALLED.exists(), 'refuse to replace existing installed CLI')
        INSTALLED.parent.mkdir(exist_ok=True)
        shutil.copy2(binary, INSTALLED)
        save('binary.json', current)
    print('PASS normal release CLI built offline and installed:', current)


def verify(read_only=False):
    guard(read_only=read_only)
    expected = json.loads((ROOT / 'binary.json').read_text())
    require(digest(INSTALLED) == expected['sha256'], 'installed CLI hash drift')
    require(digest(ROOT / 'target/release/etas') == expected['sha256'], 'build binary hash drift')
    require((read if read_only else run)([str(INSTALLED), '--version']) == expected['version'],
            'installed CLI version drift')
    print('PASS installed normal CLI:', expected)
    return expected


def fixture(prepare=False):
    verify()
    path = ROOT / 'host-faults'
    source = REPO / 'tests/fixtures/session_store/host_faults'
    manifest = (source / 'Cargo.toml').read_text()
    for name in ('core', 'frontend', 'interpreter'):
        require(PINS[name][1] in manifest, f'fixture manifest has unexpected pin: {name}')
    if path.exists():
        require((path / 'Cargo.toml').read_text() == manifest, 'retained fixture manifest drift')
        for name in ('src/main.rs', 'setup.es'):
            require(digest(path / name) == digest(source / name), f'fixture source drift: {name}')
    else:
        shutil.copytree(source, path)
        (path / 'Cargo.toml').write_text(manifest)
        shutil.copyfile(SOURCE / 'cli/Cargo.lock', path / 'Cargo.lock')
    config = ROOT / 'cli-overrides.toml'
    # The fixture has its own lock; only already approved CLI packages may appear.
    flags = [] if prepare else ['--offline', '--locked']
    data = json.loads(run(['cargo', 'metadata', *flags, '--format-version', '1',
        '--manifest-path', str(path / 'Cargo.toml'), '--config', str(config)]))
    approved = {(p['name'], p['version'], p['source'])
                for p in json.loads((ROOT / 'cli-metadata.json').read_text())['packages']}
    expected = {p: str(SOURCE / n / 'crates' / p / 'Cargo.toml')
                for n in PINS if n != 'cli' for p in PINS[n][3].split()}
    origins = {}
    for package in data['packages']:
        name = package['name']
        if name == 'nomo-session-store-host-faults':
            continue
        require((name, package['version'], package['source']) in approved, f'new fixture dependency: {package}')
        if name.startswith('etas_'):
            require(name not in origins and package['source'] is None
                    and package['manifest_path'] == expected.get(name), f'fixture mixed origin: {package}')
            origins[name] = package['manifest_path']
    require(origins == expected, 'fixture Etas graph incomplete')
    if prepare:
        run(['cargo', 'fetch', '--locked', '--manifest-path', str(path / 'Cargo.toml'),
             '--config', str(config)])
        save('host-faults-prepared.json', {'lock_sha256': digest(path / 'Cargo.lock'),
             'origins': origins, 'cli_lock_sha256': LOCKS['cli']})
        print('PASS prepared fixture using only approved CLI packages')
        return
    prepared = json.loads((ROOT / 'host-faults-prepared.json').read_text())
    require(digest(path / 'Cargo.lock') == prepared['lock_sha256']
            and origins == prepared['origins'] and prepared['cli_lock_sha256'] == LOCKS['cli'],
            'fixture preparation drift')
    run(['cargo', 'build', '--offline', '--locked', '--manifest-path', str(path / 'Cargo.toml'),
         '--config', str(config)], timeout=1800)
    identity = {'fixture_lock_sha256': digest(path / 'Cargo.lock'),
        'fixture_source_sha256': {p: digest(path / p) for p in ('Cargo.toml', 'src/main.rs', 'setup.es')},
        'fixture_binary_sha256': digest(ROOT / 'target/debug/nomo-session-store-host-faults'),
        'fixed_revisions': {n: pin[1] for n, pin in PINS.items()}}
    if (ROOT / 'host-faults-identity.json').exists():
        require(identity == json.loads((ROOT / 'host-faults-identity.json').read_text()), 'fixture identity drift')
    save('host-faults-metadata.json', data)
    save('host-faults-origins.json', origins)
    save('host-faults-identity.json', identity)
    print('PASS same-graph offline Host test fixture:', identity)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'guard', 'build', 'verify', 'fixture-prepare', 'fixture'])
    parser.add_argument('--read-only', action='store_true', help='verify retained graph without cache writes or Cargo metadata')
    options = parser.parse_args()
    mode = options.mode
    if options.read_only:
        require(mode in ('guard', 'verify'), '--read-only is for guard/verify only')
        (guard if mode == 'guard' else verify)(read_only=True)
        return
    if mode == 'fixture-prepare':
        fixture(prepare=True)
        return
    {'prepare': prepare, 'guard': guard, 'build': build, 'verify': verify, 'fixture': fixture}[mode]()


if __name__ == '__main__':
    main()
