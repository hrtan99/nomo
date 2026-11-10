#!/usr/bin/env python3
"""Shared official graph preparation and immutable cache verification."""
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
CACHE = Path('/home/nomo/.cargo')
TARGET = CACHE / 'etas-latest/target'
INSTALLED = CACHE / 'bin/etas'


def configure(label, wrapper):
    global LABEL, VERSION, SELECTOR, CONFIG, LOCK, SPEC, PINS, ROOT, SOURCE, TARGET, INSTALLED, BOOTSTRAP_SHA, LEGACY_SHA, PREVIOUS_CONFIG, PREVIOUS_SHARED, PREVIOUS_BOOTSTRAP, PREVIOUS_CURRENT, ADOPTED
    versions = {'012': ('0.1.12', 'e13f4988826cef49555dfb7cbc5dfb968a517f8b8506d3ef36789d3ec8492b56'),
                '022': ('0.2.2', 'b585d9bf44b1482eba4d733016fe1b1566a23393f844989e3bc1b42af4277846'),
                '023': ('0.2.3', None),
                '024': ('0.2.4', None),
                '025': ('0.2.5', None), '026': ('0.2.6', None), '026-v68': ('0.2.6', None), '030': ('0.3.0', None),
                '041': ('0.4.1', None), '0120': ('0.12.0', None), '0121': ('0.12.1', None)}
    require(label in versions, 'unsupported official graph')
    LABEL = label
    VERSION, LEGACY_SHA = versions[label]
    SELECTOR = 'latest' + label.replace('-', '')
    CONFIG = REPO / ('config/etas-latest-main.json' if label == '0121' else 'config/etas-' + label + '-official.json')
    LOCK = REPO / ('config/etas-latest.Cargo.lock' if label == '0121' else 'config/etas-' + label + '-official.Cargo.lock')
    SPEC = json.loads(CONFIG.read_text())
    PINS = SPEC['repositories']
    ROOT = CACHE / SPEC.get('cache_root', 'etas-latest' if label in ('041', '0120', '0121') else 'etas-eval' if label == '026-v68' else 'etas-' + label if label in ('025', '026', '030') else 'etas-p0-' + label)
    SOURCE = ROOT / ('src' if label in ('025', '026', '026-v68', '030') else 'src/cli')
    TARGET = CACHE / SPEC['build_target'] if 'build_target' in SPEC else ROOT / 'target' if label in ('025', '026', '026-v68', '030') else CACHE / 'etas-latest/target'
    INSTALLED = CACHE / SPEC.get('installed_binary', 'bin/etas')
    PREVIOUS_CONFIG = '98ff380d7e04ca43bca7f28f4af30dcd72e0a5a80dbe6515df41925f6d032962' if label == '041' else None
    bridge_path = REPO / 'config/etas-official-legacy-bridge.json'
    bridge = json.loads(bridge_path.read_text())
    entry = None if label in ('041', '0120', '0121') else bridge[label]
    if entry is not None:
        require(bridge['format'] == 1 and entry['legacy_sha256'] == LEGACY_SHA, 'legacy bridge policy drift')
        require(entry['wrapper_sha256'] == digest(wrapper), 'bootstrap wrapper drift')
        require(entry['common_sha256'] == digest(__file__), 'shared bootstrap drift')
    previous = {'012': 'f51e2b184927c47f109fbf1e3778d804abe06be1ff5c9c87ec2e2468e5782b1d',
                '022': '1abd68df1a97c80190f025b6f2330e130e924b3b299494c8e80ea6ca562adcbc',
                '023': None,
                '024': None, '025': None, '026': None, '026-v68': None, '030': None}
    PREVIOUS_SHARED = previous.get(label)
    if entry is not None: require(entry.get('previous_shared_sha256') == PREVIOUS_SHARED, 'previous shared provenance drift')
    prior = {'012': '29663ca202861ccc54cf7df5fe1c2f278ae8192d8f2d7abd41dfd44aebc2e5c4',
             '022': '5252858a71ac814ce1c15d5c0e5d8a291c0af69ed07d02c7d88343b5e8905f22',
             '023': '0fd4152065d3ab56f4a3508ecb0686bf2eab253f0f5be5b2482dfc4f933184fc', '024': None, '025': None, '026': None, '026-v68': None, '030': None,
             '041': 'a1ed042bd53279891f0e1b381fe01735fbc0ba17d949b55d1852523c0c26448b'}
    PREVIOUS_BOOTSTRAP = prior.get(label)
    if entry is not None: require(entry.get('previous_bootstrap_sha256') == PREVIOUS_BOOTSTRAP, 'previous bootstrap provenance drift')
    previous_current = {'012': 'd9136e020ec5cbe83457cabef11c993d1c9eb93d2406dfc68fce0f727f207d61',
                        '022': 'cb5feaeefdbad42b3b1253755e0167e9023664f6b1b38ef2b814aa118638b9bf',
                        '023': '90cb9bba2e7d7a52a688cac3faa4c5b74b144f2f8e87ba36c1f083810288c170',
                        '024': '89c11a09f408387c5d1e1a801bb9770517c6a30b9b95d366f2d43aa5f3c75274', '025': None, '026': None, '026-v68': None, '030': None,
                        '041': 'cae41719da26e5bb667992d388aa0f0d23ad0f1fde3f162d31334830ba9bb3fb'}
    PREVIOUS_CURRENT = previous_current.get(label)
    if entry is not None: require(entry.get('previous_current_sha256') == PREVIOUS_CURRENT, 'previous current bootstrap provenance drift')
    # New installations bind the wrapper, shared implementation and reviewed bridge policy.
    identity_hash = hashlib.sha256(b'nomo.official-bootstrap.v2\0')
    identity_hash.update(Path(wrapper).read_bytes())
    identity_hash.update(b'\0')
    identity_hash.update(Path(__file__).read_bytes())
    identity_hash.update(b'\0')
    if entry is not None: identity_hash.update(bridge_path.read_bytes())
    BOOTSTRAP_SHA = identity_hash.hexdigest()
    ADOPTED = 'source-lock-registry-validated-owner-built-' + label if label in ('025', '026', '026-v68', '030') else 'adopted-independently-verified-' + label + '-build'


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
    require(os.environ.get('CARGO_TARGET_DIR') == str(TARGET), 'unexpected CARGO_TARGET_DIR')
    require(os.environ.get('CARGO_BUILD_JOBS', '1') == '1', 'one Cargo job required')
    allowed = {'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'CARGO_TERM_COLOR'}
    forbidden = [x for x in os.environ if x.startswith('CARGO_') and x not in allowed]
    forbidden += [x for x in ('RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC', 'RUSTDOC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER') if x in os.environ]
    require(not forbidden, 'unapproved Cargo/Rust overrides: ' + str(forbidden))
    require(CACHE.resolve() == CACHE and ROOT.resolve() == ROOT, 'symlinked cache root')
    for directory in (CACHE, Path('/.cargo'), Path('/home/.cargo'), Path('/home/nomo/.cargo'), REPO / '.cargo', ROOT / '.cargo', SOURCE.parent / '.cargo', SOURCE / '.cargo'):
        for name in ('config', 'config.toml'):
            require(not (directory / name).exists(), 'unexpected Cargo config: ' + str(directory / name))
    require(SPEC['selector'] == SELECTOR and set(PINS) == {'cli', 'core', 'frontend', 'interpreter'}, 'invalid graph configuration')
    require(len(source_override_keys()) == len(set(source_override_keys())) and
            set(source_override_keys()) <= {'core', 'frontend', 'interpreter'}, 'invalid dependency source overrides')
    require(digest(LOCK) == SPEC['cargo_lock_sha256'], 'repository CLI lock drift')


def source_override_keys():
    configured = tuple(SPEC.get('source_overrides', ()))
    # The 0.3.0 graph predates the generic source_overrides field. Preserve
    # its reviewed frontend PR override while newer graphs may name any of the
    # three upstream source repositories explicitly.
    if SPEC.get('frontend_override'):
        require(not configured or configured == ('frontend',), 'conflicting frontend dependency overrides')
        return ('frontend',)
    return configured


def source_overrides():
    return ''.join('\n[patch."https://github.com/etas-project/' + PINS[key]['repository'] + '.git"]\n' +
                   ''.join(name + ' = { path = "' + str(ROOT / key / 'crates' / name) + '" }\n'
                           for name in PINS[key]['packages']) for key in source_override_keys())


def git_guard(path, key, check_origin=False):
    pin = PINS[key]
    require(path.is_dir() and path.resolve() == path, 'invalid source root: ' + key)
    require(read(['git', 'rev-parse', 'HEAD'], cwd=path).strip() == pin['revision'], 'revision drift: ' + key)
    require(read(['git', 'rev-parse', 'HEAD^{tree}'], cwd=path).strip() == pin['tree'], 'tree drift: ' + key)
    changes = read(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=path).strip()
    if key == 'cli' and source_override_keys():
        require(changes == 'M Cargo.toml', 'CLI override changed other sources')
        original = read(['git', 'show', 'HEAD:Cargo.toml'], cwd=path)
        require((path / 'Cargo.toml').read_text() == original + source_overrides(), 'dependency source override drift')
    else:
        require(not changes, 'tracked source drift: ' + key)
    extras = read(['git', 'ls-files', '--others', '--exclude-standard'], cwd=path).splitlines()
    require(set(extras) <= ({'Cargo.lock'} if key == 'cli' else {'.cargo-ok'}), 'unexpected source files: ' + key)
    ignored = read(['git', 'ls-files', '--others', '--ignored', '--exclude-standard'], cwd=path).splitlines()
    require(set(ignored) <= ({'Cargo.lock'} if key == 'cli' else set()), 'unexpected ignored source files: ' + key)
    if check_origin:
        expected = 'https://github.com/etas-project/' + PINS[key]['repository'] + '.git'
        require(read(['git', 'remote', 'get-url', 'origin'], cwd=path).strip() == expected, 'Git origin drift: ' + key)


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
        elif key in source_override_keys():
            root = ROOT / key
            require(origin is None and manifest == root / 'crates' / name / 'Cargo.toml', 'source override drift: ' + name)
            roots[key] = root
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
        print('PASS already prepared official ' + LABEL + ' graph')
        return
    require(not INSTALLED.exists(), 'refuse replacement of existing normal graph')
    require(not ROOT.exists(), 'refuse pre-existing unowned normal cache')
    ROOT.mkdir(parents=True)
    save('bootstrap-owner.json', SPEC)
    SOURCE.parent.mkdir(exist_ok=True)
    if sources is None:
        run(['git', 'clone', '--no-checkout', 'https://github.com/etas-project/etas.git', SOURCE])
        run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', PINS['cli']['revision']], cwd=SOURCE)
    else:
        require((sources / '.git').is_dir() and sources.resolve() == sources, 'CLI source must retain official git metadata and not be symlinked')
        for directory, dirs, files in os.walk(sources, followlinks=False):
            require(not any((Path(directory) / name).is_symlink() for name in dirs + files), 'symlink in source seed')
        shutil.copytree(sources, SOURCE, symlinks=True)
    for key in source_override_keys():
        root = ROOT / key
        run(['git', 'clone', '--no-checkout', 'https://github.com/etas-project/' + PINS[key]['repository'] + '.git', root])
        run(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', PINS[key]['revision']], cwd=root)
        git_guard(root, key, check_origin=True)
    if source_override_keys():
        with (SOURCE / 'Cargo.toml').open('a') as stream:
            stream.write(source_overrides())
    git_guard(SOURCE, 'cli', check_origin=True)
    if (SOURCE / 'Cargo.lock').exists():
        require(digest(SOURCE / 'Cargo.lock') == digest(LOCK), 'upstream Cargo.lock differs from the pinned lock')
    else:
        shutil.copyfile(LOCK, SOURCE / 'Cargo.lock')
    require(seed is None, 'registry/git seeds are not trusted; resolve from official sources into a fresh cache')
    require(not (CACHE / 'registry').exists() and not (CACHE / 'git').exists(), 'official dependency resolution requires a fresh cache')
    command = ['cargo', 'metadata', '--locked', '--format-version', '1']
    metadata = json.loads(run(command, cwd=SOURCE))
    origins = graph_guard(metadata)
    registry_guard()
    save('cli-metadata.json', metadata)
    save('cli-origins.json', origins)
    save('identity.json', {'pins': PINS, 'configuration_sha256': digest(CONFIG), 'bootstrap_sha256': BOOTSTRAP_SHA,
        'lock_sha256': digest(LOCK), 'metadata_sha256': digest(ROOT / 'cli-metadata.json'), 'origins_sha256': digest(ROOT / 'cli-origins.json'),
        'rustc': read(['rustc', '-vV']), 'cargo': read(['cargo', '-V'])})
    print('PASS prepared pinned ETAS Git graph')


def register_existing(binary):
    """Register an independently prepared graph in this isolated cache.

    All validation precedes writes. Partial registration is never overwritten
    or silently repaired; a fresh isolated cache is required after failure.
    """
    guard_environment()
    require(ROOT.is_dir() and ROOT.resolve() == ROOT, 'prepared graph missing or symlinked')
    require(not INSTALLED.exists() and not INSTALLED.is_symlink(), 'refuse installed binary replacement')
    for name in ('identity.json', 'binary.json', 'cli-metadata.json', 'cli-origins.json'):
        path = ROOT / name
        require(not path.exists() and not path.is_symlink(), 'refuse partial or existing registration: ' + name)
    git_guard(SOURCE, 'cli', check_origin=True)
    require(digest(SOURCE / 'Cargo.lock') == digest(LOCK), 'prepared source lock drift')
    require(binary.is_file() and not binary.is_symlink() and digest(binary) == SPEC['verified_seed_binary_sha256'], 'verified seed binary drift')
    require(read([binary, '--version']) == ('etas ' + VERSION + '\n'), 'verified seed version drift')
    metadata = json.loads(read(['cargo', 'metadata', '--offline', '--locked', '--format-version', '1'], cwd=SOURCE))
    origins = graph_guard(metadata)
    registry_guard()
    git_guard(SOURCE, 'cli', check_origin=True)
    require(digest(SOURCE / 'Cargo.lock') == digest(LOCK), 'prepared source lock changed')
    save('cli-metadata.json', metadata)
    save('cli-origins.json', origins)
    save('identity.json', {'pins': PINS, 'configuration_sha256': digest(CONFIG), 'bootstrap_sha256': BOOTSTRAP_SHA,
        'lock_sha256': digest(LOCK), 'metadata_sha256': digest(ROOT / 'cli-metadata.json'), 'origins_sha256': digest(ROOT / 'cli-origins.json'),
        'rustc': read(['rustc', '-vV']), 'cargo': read(['cargo', '-V'])})
    guard(read_only=True)
    return install(binary, ADOPTED)


def guard(read_only=False):
    guard_environment()
    identity = json.loads((ROOT / 'identity.json').read_text())
    require(identity['pins'] == PINS and identity['configuration_sha256'] in tuple(x for x in (digest(CONFIG), PREVIOUS_CONFIG) if x), 'graph configuration drift')
    # Existing cache records name the exact pre-sharing verifier; new records
    # bind both the selected wrapper and this implementation. Both branches
    # still run the full source, lock, toolchain and registry checks below.
    provenance = identity['bootstrap_sha256']
    accepted = [BOOTSTRAP_SHA]
    previous_baseline = {'012': 'b6dbd491e61aaf8588bbfe210b20039db71d00ab790849831ee5eb429bb1155d', '022': 'cc555681fcd284547c0405c6b6bc9b57d25c398c7ed1a857327e105ff02c11ea', '023': '47c7a8fe3b5a2fcff7458714d27400a25fd89aa436baa4f317cb0eda670e0c67', '024': '0204af17073268062fe2d90c8cbb25cf73f6cd9eee85c916c9f4ca5ece4f6d52', '025': '393fd743eccc787fe61c9396f94056ae3596a469a21701cc53ab35c47d95b545', '026': '01ce30cc977ec6d7de2e05aea3727f8dbb31e5462d85dd747919022eeffe4b57', '026-v68': '01ce30cc977ec6d7de2e05aea3727f8dbb31e5462d85dd747919022eeffe4b57'}
    if LABEL in previous_baseline: accepted.append(previous_baseline[LABEL])
    previous_refactor = {'012': '39b0277800140388d34d678bc3f07dbf10d240888fb31956d09cb999dc7a503c', '022': '9bc1745be5eb056eca102314930db86901f1c81c0dae957b84d6d96d2a93b176', '023': '96ff100859d8eb9000d190888515eb05056da32555c81e0a5b5a0d81cb3db63d', '024': '3ffddeb87a4deb59304825e7bc6103b7f6bcfb889df5c764eb4801c9be21dd46', '025': 'a9c166409d8bacc39a1e4af3e83451241da6efe33d35082077a36298cb3da458'}
    if LABEL in previous_refactor: accepted.append(previous_refactor[LABEL])
    previous_v2 = {'012': '01552d56e137654ce92a5a5a8f9a87bc453acd64b7a330e329b9c4fbbd26ffc0', '022': '91ea6d4934155e5e6265c3df75f6848354b76fbf4a8f434b7625165a83635cc3', '023': '49de480236faa63d3ca9848e612e216c393c18b6840bd9885d562e4e21fb453d', '024': 'c5ed54add4b7f5d3329845e16a12ae2fdecad7687f286860fc56cb4d6ea893db', '025': '48d947d96597cfdb5225ac4c1b851e4dd870eedf55ad0d51c29b4f56029cc3e4', '026': '2f5b586e027532be033d071ac8179160b78cce7e83586fbc56c40ce7efb5342a',
        '030': '2ebc9bef95b024ef35f8ac4075e8268d2d547f980a8951f91381b22f22a206e7',
        '041': '4da692d577464b972d83189ccca5d7caa74807a38dcbb5f054c8462ec1dff55e',
        '0120': 'febe626fa1e919cd9a9bbd8616f27183524ce41dd97b999176f23b7198ef4a77'}
    if LABEL in previous_v2: accepted.append(previous_v2[LABEL])
    # The 0.4.1 storage-limit pin was prepared and built before its independently
    # reproduced binary hash replaced the prior graph hash in the reviewed spec.
    if LABEL == '041': accepted.append('ddeb6d22d76a7ad8159e04bc504b38560e87e374df8e921004426bcbb0077c42')
    if LEGACY_SHA is not None: accepted.append(LEGACY_SHA)
    if PREVIOUS_SHARED is not None: accepted.append(PREVIOUS_SHARED)
    if PREVIOUS_BOOTSTRAP is not None: accepted.append(PREVIOUS_BOOTSTRAP)
    if PREVIOUS_CURRENT is not None: accepted.append(PREVIOUS_CURRENT)
    require(provenance in accepted, 'bootstrap drift')
    git_guard(SOURCE, 'cli', check_origin=True)
    require(digest(SOURCE / 'Cargo.lock') == digest(LOCK) == identity['lock_sha256'], 'CLI lock drift')
    require(read(['rustc', '-vV']) == identity['rustc'] and read(['cargo', '-V']) == identity['cargo'], 'Rust toolchain drift')
    require(digest(ROOT / 'cli-metadata.json') == identity['metadata_sha256'] and digest(ROOT / 'cli-origins.json') == identity['origins_sha256'], 'metadata drift')
    require(graph_guard(json.loads((ROOT / 'cli-metadata.json').read_text())) == json.loads((ROOT / 'cli-origins.json').read_text()), 'origin drift')
    registry_guard()
    return 'legacy-revalidated' if provenance == LEGACY_SHA else 'shared-verified'


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
    require(digest(TARGET / 'release/etas') == SPEC['verified_seed_binary_sha256'], 'built binary differs from reviewed build; retain build evidence for review')
    return install(TARGET / 'release/etas', 'built-official-locked-graph')


def adopt(binary):
    guard()
    require(digest(binary) == SPEC['verified_seed_binary_sha256'], 'seed binary is not the independently verified ' + LABEL + ' build')
    if (ROOT / 'binary.json').exists():
        return verify(read_only=True)
    return install(binary, ADOPTED)


def verify(read_only=False):
    provenance = guard(read_only=read_only)
    identity = json.loads((ROOT / 'binary.json').read_text())
    require(identity['path'] == str(INSTALLED) and digest(INSTALLED) == identity['sha256'], 'installed CLI drift')
    require(identity['method'] in ('built-official-locked-graph', ADOPTED), 'unknown binary provenance')
    require(identity['sha256'] == SPEC['verified_seed_binary_sha256'], 'binary is not the independently verified ' + LABEL + ' build')
    require(identity['lock_sha256'] == digest(LOCK) and read([INSTALLED, '--version']) == identity['version'] == ('etas ' + VERSION + '\n'), 'CLI version/lock drift')
    print('PASS selected official ' + VERSION + ' CLI (' + provenance + '): ' + json.dumps(identity, sort_keys=True))
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'build', 'adopt', 'register-existing', 'guard', 'verify'])
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
    elif options.mode == 'register-existing':
        require(options.binary is not None and options.sources is None and options.seed is None, 'register-existing needs only --binary')
        register_existing(options.binary)
    else:
        require(options.sources is None and options.seed is None and options.binary is None, 'extra arguments not allowed')
        {'build': build, 'guard': guard, 'verify': verify}[options.mode]()
