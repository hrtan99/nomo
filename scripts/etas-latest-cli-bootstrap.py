#!/usr/bin/env python3
"""Build or adopt the official CLI's unmodified 011 Git dependency graph."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import time
import tomllib

REPO = Path(__file__).resolve().parent.parent
CONFIG = REPO / 'config/etas-latest-main.json'
LOCK = REPO / 'config/etas-011.Cargo.lock'
SPEC = json.loads(CONFIG.read_text())
PINS = SPEC['repositories']
CACHE = Path('/home/nomo/.cargo')
ROOT = CACHE / 'etas-latest'
SOURCE = ROOT / 'src/cli'
INSTALLED = CACHE / 'bin/etas'


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(argv, cwd=None, timeout=120):
    return subprocess.run(list(map(str, argv)), cwd=cwd, check=True, capture_output=True, text=True, timeout=timeout).stdout


def run(argv, cwd=None, timeout=3600):
    logs = ROOT / 'logs'
    logs.mkdir(exist_ok=True)
    path = logs / (str(time.time_ns()) + '.json')
    args = list(map(str, argv))
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        path.write_text(json.dumps({'command': args, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, indent=2) + '\n')
    except subprocess.TimeoutExpired as error:
        path.write_text(json.dumps({'command': args, 'timeout': True, 'stdout': str(error.stdout), 'stderr': str(error.stderr)}, indent=2) + '\n')
        raise
    require(result.returncode == 0, 'command failed; retained ' + str(path))
    return result.stdout


def guard_environment():
    require(platform.system() == 'Linux' and platform.machine() == 'aarch64', 'Linux/arm64 Docker required')
    require(os.environ.get('CARGO_HOME') == str(CACHE), 'unexpected CARGO_HOME')
    require(os.environ.get('CARGO_TARGET_DIR') == str(ROOT / 'target'), 'unexpected CARGO_TARGET_DIR')
    require(os.environ.get('CARGO_BUILD_JOBS', '1') == '1', 'one Cargo job required')
    allowed = {'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'CARGO_TERM_COLOR'}
    forbidden = [x for x in os.environ if x.startswith('CARGO_') and x not in allowed]
    forbidden += [x for x in ('RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC', 'RUSTDOC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER') if x in os.environ]
    require(not forbidden, 'unapproved Cargo/Rust overrides: ' + str(forbidden))
    require(CACHE.resolve() == CACHE and ROOT.resolve() == ROOT, 'symlinked cache root')
    for directory in (CACHE, Path('/.cargo'), Path('/home/.cargo'), Path('/home/nomo/.cargo'), REPO / '.cargo', ROOT / '.cargo', SOURCE.parent / '.cargo', SOURCE / '.cargo'):
        for name in ('config', 'config.toml'):
            require(not (directory / name).exists(), 'unexpected Cargo config: ' + str(directory / name))
    require(SPEC['selector'] == 'latest' and set(PINS) == {'cli', 'core', 'frontend', 'interpreter'}, 'invalid graph configuration')
    require(digest(LOCK) == SPEC['cargo_lock_sha256'], 'repository CLI lock drift')


def git_guard(path, key, check_origin=False):
    pin = PINS[key]
    require(path.is_dir() and path.resolve() == path, 'invalid source root: ' + key)
    require(read(['git', 'rev-parse', 'HEAD'], cwd=path).strip() == pin['revision'], 'revision drift: ' + key)
    require(read(['git', 'rev-parse', 'HEAD^{tree}'], cwd=path).strip() == pin['tree'], 'tree drift: ' + key)
    require(not read(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=path).strip(), 'tracked source drift: ' + key)
    extras = read(['git', 'ls-files', '--others', '--exclude-standard'], cwd=path).splitlines()
    require(set(extras) <= ({'Cargo.lock'} if key == 'cli' else {'.cargo-ok'}), 'unexpected source files: ' + key)
    ignored = read(['git', 'ls-files', '--others', '--ignored', '--exclude-standard'], cwd=path).splitlines()
    require(set(ignored) <= ({'Cargo.lock'} if key == 'cli' else set()), 'unexpected ignored source files: ' + key)
    if check_origin:
        require(read(['git', 'remote', 'get-url', 'origin'], cwd=path).strip() == 'https://github.com/etas-project/etas.git', 'CLI origin drift')


def graph_guard(data):
    expected = {package: key for key, pin in PINS.items() for package in pin['packages']}
    observed = {}
    roots = {}
    for package in data['packages']:
        name = package['name']
        if not name.startswith('etas_'):
            continue
        require(name in expected and name not in observed, 'unexpected/duplicate Etas package: ' + name)
        key = expected[name]
        origin = package.get('source')
        manifest = Path(package['manifest_path'])
        if key == 'cli':
            require(origin is None and manifest == SOURCE / 'crates' / name / 'Cargo.toml', 'CLI package source drift: ' + name)
        else:
            pin = PINS[key]
            expected_source = 'git+https://github.com/etas-project/' + pin['repository'] + '.git?rev=' + pin['revision'] + '#' + pin['revision']
            require(origin == expected_source, 'official Git origin drift: ' + name)
            root = manifest.parent.parent.parent
            require(manifest == root / 'crates' / name / 'Cargo.toml', 'package path drift: ' + name)
            require(key not in roots or roots[key] == root, 'mixed source roots: ' + key)
            roots[key] = root
        observed[name] = {'repository': key, 'source': origin, 'manifest_path': str(manifest)}
    require(set(observed) == set(expected) and set(roots) == {'core', 'frontend', 'interpreter'}, 'incomplete official graph')
    for key, path in roots.items():
        git_guard(path, key)
    return observed


def registry_guard():
    # Cargo.lock is authoritative for archive bytes; compare every extracted
    # input to its corresponding authenticated crate rather than trusting cache.
    locked = tomllib.loads(LOCK.read_text())
    for package in locked['package']:
        if not package.get('source', '').startswith('registry+'):
            continue
        name, version = package['name'], package['version']
        stem = name + '-' + version
        archives = list((CACHE / 'registry/cache').glob('*/' + stem + '.crate'))
        sources = list((CACHE / 'registry/src').glob('*/' + stem))
        require(len(archives) == len(sources) == 1, 'missing or ambiguous registry crate: ' + stem)
        archive, directory = archives[0], sources[0]
        require(archive.resolve() == archive and directory.resolve() == directory, 'symlinked registry crate: ' + stem)
        require(digest(archive) == package['checksum'], 'registry archive checksum drift: ' + stem)
        expected = {}
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar:
                path = Path(member.name)
                require(not path.is_absolute() and '..' not in path.parts and path.parts[0] == stem, 'invalid crate archive path: ' + stem)
                if member.isdir():
                    continue
                require(member.isfile() and len(path.parts) > 1, 'unsupported crate archive member: ' + stem)
                relative = Path(*path.parts[1:])
                require(str(relative) not in expected, 'duplicate crate member: ' + stem)
                stream = tar.extractfile(member)
                require(stream is not None, 'unreadable crate member: ' + stem)
                expected[str(relative)] = hashlib.sha256(stream.read()).hexdigest()
        observed = {}
        for path in directory.rglob('*'):
            require(not path.is_symlink(), 'symlinked registry source: ' + stem)
            if path.is_file() and path.relative_to(directory) != Path('.cargo-ok'):
                observed[str(path.relative_to(directory))] = digest(path)
        require(observed == expected, 'extracted registry source drift: ' + stem)


def save(name, data):
    (ROOT / name).write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')


def prepare(sources=None, seed=None):
    guard_environment()
    if (ROOT / 'identity.json').exists():
        guard(read_only=True)
        print('PASS already prepared official 011 graph')
        return
    require(not INSTALLED.exists(), 'refuse replacement of existing normal graph')
    require(not ROOT.exists(), 'refuse pre-existing unowned normal cache')
    ROOT.mkdir(parents=True)
    save('bootstrap-owner.json', SPEC)
    SOURCE.parent.mkdir()
    if sources is None:
        run(['git', 'clone', '--no-checkout', 'https://github.com/etas-project/etas.git', SOURCE])
        run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', PINS['cli']['revision']], cwd=SOURCE)
    else:
        require((sources / '.git').is_dir() and sources.resolve() == sources, 'CLI source must retain official git metadata and not be symlinked')
        for directory, dirs, files in os.walk(sources, followlinks=False):
            require(not any((Path(directory) / name).is_symlink() for name in dirs + files), 'symlink in source seed')
        shutil.copytree(sources, SOURCE, symlinks=True)
    git_guard(SOURCE, 'cli', check_origin=True)
    require(not (SOURCE / 'Cargo.lock').exists(), 'unexpected source Cargo.lock')
    shutil.copyfile(LOCK, SOURCE / 'Cargo.lock')
    require(seed is None, 'registry/git seeds are not trusted; resolve from official sources into a fresh cache')
    require(not (CACHE / 'registry').exists() and not (CACHE / 'git').exists(), 'official dependency resolution requires a fresh cache')
    command = ['cargo', 'metadata', '--locked', '--format-version', '1']
    metadata = json.loads(run(command, cwd=SOURCE))
    origins = graph_guard(metadata)
    registry_guard()
    save('cli-metadata.json', metadata)
    save('cli-origins.json', origins)
    save('identity.json', {'pins': PINS, 'configuration_sha256': digest(CONFIG), 'bootstrap_sha256': digest(Path(__file__)),
        'lock_sha256': digest(LOCK), 'metadata_sha256': digest(ROOT / 'cli-metadata.json'), 'origins_sha256': digest(ROOT / 'cli-origins.json'),
        'rustc': read(['rustc', '-vV']), 'cargo': read(['cargo', '-V'])})
    print('PASS prepared official Git graph; no local patches')


def guard(read_only=False):
    guard_environment()
    identity = json.loads((ROOT / 'identity.json').read_text())
    require(identity['pins'] == PINS and identity['configuration_sha256'] == digest(CONFIG), 'graph configuration drift')
    require(identity['bootstrap_sha256'] == digest(Path(__file__)), 'bootstrap drift')
    git_guard(SOURCE, 'cli', check_origin=True)
    require(digest(SOURCE / 'Cargo.lock') == digest(LOCK) == identity['lock_sha256'], 'CLI lock drift')
    require(read(['rustc', '-vV']) == identity['rustc'] and read(['cargo', '-V']) == identity['cargo'], 'Rust toolchain drift')
    require(digest(ROOT / 'cli-metadata.json') == identity['metadata_sha256'] and digest(ROOT / 'cli-origins.json') == identity['origins_sha256'], 'metadata drift')
    require(graph_guard(json.loads((ROOT / 'cli-metadata.json').read_text())) == json.loads((ROOT / 'cli-origins.json').read_text()), 'origin drift')
    registry_guard()


def install(binary, method):
    require(not INSTALLED.exists() and not (ROOT / 'binary.json').exists(), 'refuse binary replacement')
    INSTALLED.parent.mkdir(exist_ok=True)
    shutil.copy2(binary, INSTALLED)
    save('binary.json', {'path': str(INSTALLED), 'sha256': digest(binary), 'version': read([INSTALLED, '--version']), 'method': method, 'lock_sha256': digest(LOCK)})
    return verify(read_only=True)


def build():
    guard()
    if (ROOT / 'binary.json').exists():
        return verify(read_only=True)
    run(['cargo', 'build', '--offline', '--locked', '--release', '--package', 'etas_cli', '--bin', 'etas'], cwd=SOURCE)
    guard()
    require(digest(ROOT / 'target/release/etas') == SPEC['verified_seed_binary_sha256'], 'built binary differs from reviewed build; retain build evidence for review')
    return install(ROOT / 'target/release/etas', 'built-official-locked-graph')


def adopt(binary):
    guard()
    require(digest(binary) == SPEC['verified_seed_binary_sha256'], 'seed binary is not the independently verified 011 build')
    if (ROOT / 'binary.json').exists():
        return verify(read_only=True)
    return install(binary, 'adopted-independently-verified-011-build')


def verify(read_only=False):
    guard(read_only=read_only)
    identity = json.loads((ROOT / 'binary.json').read_text())
    require(identity['path'] == str(INSTALLED) and digest(INSTALLED) == identity['sha256'], 'installed CLI drift')
    require(identity['method'] in ('built-official-locked-graph', 'adopted-independently-verified-011-build'), 'unknown binary provenance')
    require(identity['sha256'] == SPEC['verified_seed_binary_sha256'], 'binary is not the independently verified 011 build')
    require(identity['lock_sha256'] == digest(LOCK) and read([INSTALLED, '--version']) == identity['version'] == 'etas 0.1.8\n', 'CLI version/lock drift')
    print('PASS selected official 011 CLI: ' + json.dumps(identity, sort_keys=True))
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'build', 'adopt', 'guard', 'verify'])
    parser.add_argument('--sources', type=Path)
    parser.add_argument('--seed', type=Path)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--read-only', action='store_true')
    options = parser.parse_args()
    require(not options.read_only or options.mode in ('guard', 'verify'), '--read-only is for guard/verify')
    if options.mode == 'prepare':
        require(options.binary is None, '--binary is adopt-only')
        prepare(options.sources, options.seed)
    elif options.mode == 'adopt':
        require(options.binary is not None and options.sources is None and options.seed is None, 'adopt needs only --binary')
        adopt(options.binary)
    else:
        require(options.sources is None and options.seed is None and options.binary is None, 'extra arguments not allowed')
        {'build': build, 'guard': guard, 'verify': verify}[options.mode]()


if __name__ == '__main__':
    main()
