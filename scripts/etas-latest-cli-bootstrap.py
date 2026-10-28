#!/usr/bin/env python3
"""Frozen merged-main Etas CLI, isolated Linux cache, offline release build."""
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
CONFIG = REPO / 'config/etas-latest-main.json'
CONFIGURATION = json.loads(CONFIG.read_text())
PINS = CONFIGURATION['repositories']
CACHE = Path('/home/nomo/.cargo')
ROOT = CACHE / 'etas-latest'
SOURCE = ROOT / 'src'
INSTALLED = CACHE / 'bin/etas'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def read(args, *, cwd=ROOT):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True, timeout=60).stdout


def run(args, *, cwd=ROOT, timeout=1200):
    logs = ROOT / 'logs'
    logs.mkdir(exist_ok=True)
    path = logs / (str(time.time_ns()) + '.json')
    print('+ ' + ' '.join(map(str, args)), flush=True)
    try:
        result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        path.write_text(json.dumps({'command': args, 'timeout': True,
            'stdout': str(error.stdout or ''), 'stderr': str(error.stderr or '')}, indent=2) + '\n')
        raise RuntimeError('command timeout; retained ' + str(path)) from error
    path.write_text(json.dumps({'command': args, 'exit': result.returncode,
        'stdout': result.stdout, 'stderr': result.stderr}, indent=2) + '\n')
    require(result.returncode == 0, 'command failed; retained ' + str(path))
    return result.stdout


def environment_guard():
    require(platform.system() == 'Linux' and platform.machine() == 'aarch64', 'Linux/arm64 Docker required')
    require(os.environ.get('CARGO_HOME') == str(CACHE), 'unexpected CARGO_HOME')
    require(os.environ.get('CARGO_TARGET_DIR') == str(ROOT / 'target'), 'unexpected CARGO_TARGET_DIR')
    require(os.environ.get('CARGO_BUILD_JOBS', '1') == '1', 'latest compiler build requires one Cargo job')
    require(CACHE.resolve() == CACHE and ROOT.resolve() == ROOT, 'symlinked cache root')
    allowed = {'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'CARGO_TERM_COLOR'}
    forbidden = [name for name in os.environ if name.startswith('CARGO_') and name not in allowed]
    forbidden += [name for name in ('RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC', 'RUSTDOC',
        'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER') if name in os.environ]
    require(not forbidden, 'unapproved Cargo/Rust overrides: ' + str(forbidden))
    for directory in [CACHE, *[path / '.cargo' for path in
            (Path('/'), Path('/home'), Path('/home/nomo'), REPO, ROOT, SOURCE)]]:
        for name in ('config', 'config.toml'):
            require(not (directory / name).exists(), 'unexpected Cargo config: ' + str(directory / name))
    require(CONFIGURATION['selector'] == 'latest' and set(PINS) == {'core', 'frontend', 'interpreter', 'cli'}, 'invalid fixed latest graph')


def config_text():
    lines = []
    for name, pin in PINS.items():
        if name != 'cli':
            lines.append('[patch."https://github.com/etas-project/' + pin['repository'] + '.git"]')
            lines.extend(package + ' = { path = "' + str(SOURCE / name / 'crates' / package) + '" }'
                         for package in pin['packages'])
    return '\n'.join(lines) + '\n'


def source_guard():
    for name, pin in PINS.items():
        path = SOURCE / name
        require(path.resolve() == path and (path / '.git').is_dir(), 'invalid source root: ' + name)
        require(read(['git', 'remote', 'get-url', 'origin'], cwd=path).strip() ==
                'https://github.com/etas-project/' + pin['repository'] + '.git', 'origin drift: ' + name)
        require(read(['git', 'rev-parse', 'HEAD'], cwd=path).strip() == pin['revision'], 'HEAD drift: ' + name)
        require(read(['git', 'rev-parse', 'HEAD^{tree}'], cwd=path).strip() == pin['tree'], 'tree drift: ' + name)
        require(not read(['git', 'diff', 'HEAD', '--', '.', ':(exclude)Cargo.lock'], cwd=path).strip(), 'source drift: ' + name)
        require(not read(['git', 'diff', '--cached', 'HEAD', '--'], cwd=path).strip(), 'index drift: ' + name)
        extras = read(['git', 'ls-files', '--others', '--exclude-standard'], cwd=path).splitlines()
        require(set(extras) <= {'Cargo.lock'}, 'unexpected source files: ' + name)


def metadata_origins(data):
    expected = {package: str(SOURCE / name / 'crates' / package / 'Cargo.toml')
                for name, pin in PINS.items() for package in pin['packages']}
    origins = {}
    for package in data['packages']:
        name = package['name']
        if name.startswith('etas_'):
            require(name not in origins and package['source'] is None, 'mixed Etas origin: ' + name)
            require(package['manifest_path'] == expected.get(name), 'wrong Etas path: ' + name)
            origins[name] = package['manifest_path']
    require(len(expected) == 21 and origins == expected, 'incomplete local Etas graph')
    return origins


def cargo(*args):
    return run(['cargo', *args, '--manifest-path', str(SOURCE / 'cli/Cargo.toml'),
                '--config', str(ROOT / 'overrides.toml')], timeout=3600)


def prepare(sources=None, seed=None):
    environment_guard()
    if (ROOT / 'identity.json').exists():
        guard(read_only=True)
        print('PASS already prepared exact merged-main graph')
        return
    if ROOT.exists():
        require(json.loads((ROOT / 'bootstrap-owner.json').read_text()) == CONFIGURATION, 'unowned latest cache root')
    else:
        require(not INSTALLED.exists(), 'refuse pre-existing installed compiler in new cache')
        ROOT.mkdir()
        save('bootstrap-owner.json', CONFIGURATION)
    SOURCE.mkdir(exist_ok=True)
    for name, pin in PINS.items():
        path = SOURCE / name
        if path.exists():
            continue
        if sources is not None:
            require((sources / name / '.git').is_dir(), 'prepared source must retain .git: ' + name)
            shutil.copytree(sources / name, path, symlinks=True)
        else:
            path.mkdir()
            run(['git', 'init', '-q', str(path)])
            run(['git', 'remote', 'add', 'origin', 'https://github.com/etas-project/' + pin['repository'] + '.git'], cwd=path)
            run(['git', 'fetch', '--depth', '1', 'origin', pin['revision']], cwd=path)
            run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'], cwd=path)
    source_guard()
    if seed is not None:
        require(seed.is_dir() and seed.resolve() != CACHE.resolve(), 'invalid read-only cache seed')
        for name in ('registry', 'git'):
            if (seed / name).exists() and not (CACHE / name).exists():
                shutil.copytree(seed / name, CACHE / name, symlinks=True)
        lock = seed / 'etas-latest/resolved.Cargo.lock'
        require(lock.is_file(), 'normal CLI seed lock unavailable')
        shutil.copyfile(lock, SOURCE / 'cli/Cargo.lock')
    overrides = ROOT / 'overrides.toml'
    if overrides.exists():
        require(overrides.read_text() == config_text(), 'override drift')
    else:
        overrides.write_text(config_text())
    data = json.loads(cargo('metadata', '--offline', '--all-features', '--format-version', '1'))
    origins = metadata_origins(data)
    save('cli-metadata.json', data)
    save('cli-origins.json', origins)
    shutil.copyfile(SOURCE / 'cli/Cargo.lock', ROOT / 'resolved.Cargo.lock')
    source_guard()
    save('identity.json', {'pins': PINS, 'configuration_sha256': digest(CONFIG),
        'lock_sha256': digest(ROOT / 'resolved.Cargo.lock'), 'overrides_sha256': digest(overrides),
        'metadata_sha256': digest(ROOT / 'cli-metadata.json'), 'origins_sha256': digest(ROOT / 'cli-origins.json'),
        'rustc': read(['rustc', '-vV']), 'cargo': read(['cargo', '-V']), 'bootstrap_sha256': digest(Path(__file__))})
    print('PASS prepared frozen merged-main graph and generated lock; no binary installed')


def guard(read_only=False):
    environment_guard()
    identity = json.loads((ROOT / 'identity.json').read_text())
    require(identity['pins'] == PINS and identity['configuration_sha256'] == digest(CONFIG), 'latest graph identity drift')
    source_guard()
    require(read(['rustc', '-vV']) == identity['rustc'] and read(['cargo', '-V']) == identity['cargo'], 'toolchain drift')
    require((ROOT / 'overrides.toml').read_text() == config_text() and
            digest(ROOT / 'overrides.toml') == identity['overrides_sha256'], 'override identity drift')
    require(digest(SOURCE / 'cli/Cargo.lock') == digest(ROOT / 'resolved.Cargo.lock') == identity['lock_sha256'], 'generated CLI lock drift')
    require(digest(ROOT / 'cli-metadata.json') == identity['metadata_sha256'] and
            digest(ROOT / 'cli-origins.json') == identity['origins_sha256'], 'retained graph metadata drift')
    require(metadata_origins(json.loads((ROOT / 'cli-metadata.json').read_text())) ==
            json.loads((ROOT / 'cli-origins.json').read_text()), 'retained origin drift')


def build():
    guard()
    if (ROOT / 'binary.json').exists():
        return verify(read_only=True)
    require(not INSTALLED.exists(), 'refuse replacement of pre-existing installed compiler')
    os.environ['CARGO_BUILD_JOBS'] = '1'
    cargo('build', '--offline', '--locked', '--release', '-p', 'etas_cli', '--all-features')
    binary = ROOT / 'target/release/etas'
    require(digest(SOURCE / 'cli/Cargo.lock') == digest(ROOT / 'resolved.Cargo.lock'), 'build changed frozen lock')
    INSTALLED.parent.mkdir(exist_ok=True)
    shutil.copy2(binary, INSTALLED)
    save('binary.json', {'path': str(INSTALLED), 'sha256': digest(binary), 'version': read([str(INSTALLED), '--version']),
                         'release': True, 'all_features': True, 'lock_sha256': digest(ROOT / 'resolved.Cargo.lock')})
    return verify(read_only=True)


def verify(read_only=False):
    guard(read_only=read_only)
    expected = json.loads((ROOT / 'binary.json').read_text())
    require(expected['path'] == str(INSTALLED) and digest(INSTALLED) == expected['sha256'], 'selected installed CLI drift')
    require(digest(ROOT / 'target/release/etas') == expected['sha256'], 'built CLI drift')
    require(read([str(INSTALLED), '--version']) == expected['version'], 'selected CLI version drift')
    print('PASS latest merged-main selected CLI: ' + json.dumps(expected, sort_keys=True))
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'build', 'guard', 'verify'])
    parser.add_argument('--sources', type=Path)
    parser.add_argument('--seed', type=Path)
    parser.add_argument('--read-only', action='store_true')
    options = parser.parse_args()
    require(not options.read_only or options.mode in ('guard', 'verify'), '--read-only is for guard/verify')
    require(options.mode == 'prepare' or (options.sources is None and options.seed is None), 'source/seed options are prepare-only')
    if options.mode == 'prepare':
        prepare(options.sources, options.seed)
    elif options.mode == 'build':
        build()
    else:
        (guard if options.mode == 'guard' else verify)(read_only=options.read_only)


if __name__ == '__main__':
    main()
