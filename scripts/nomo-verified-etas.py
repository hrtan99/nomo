#!/usr/bin/env python3
"""Start the selected official CLI only after checking its locked identity."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

CLI = Path('/home/nomo/.cargo/bin/etas')
SPEC = Path('/workspace/config/etas-022-official.json')
LOCK = Path('/workspace/config/etas-022-official.Cargo.lock')
VERSIONS = {'latest022': '0.2.2', 'latest023': '0.2.3', 'latest024': '0.2.4', 'latest025': '0.2.5', 'latest026': '0.2.6', 'latest026v68': '0.2.6'}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(cli, spec_path, lock_path, selected):
    try:
        spec = json.loads(spec_path.read_text())
        if selected not in VERSIONS or spec['selector'] != selected:
            return False
        if cli.is_symlink() or not cli.is_file() or digest(cli) != spec['verified_seed_binary_sha256']:
            return False
        if digest(lock_path) != spec['cargo_lock_sha256']:
            return False
        version = subprocess.run([str(cli), '--version'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        return version.returncode == 0 and version.stdout == ('etas ' + VERSIONS[selected] + '\n').encode() and not version.stderr
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return False


def main():
    selected = {'026-20261103-a': 'latest026', '026-v68': 'latest026v68'}.get(os.environ.get('NOMO_NORMAL_GRAPH'), os.environ.get('NOMO_NORMAL_GRAPH'))
    suffix = {'latest022': '022', 'latest023': '023', 'latest024': '024', 'latest025': '025', 'latest026': '026', 'latest026v68': '026-v68'}.get(selected)
    spec = Path('/workspace/config/etas-' + suffix + '-official.json') if suffix else SPEC
    lock = Path('/workspace/config/etas-' + suffix + '-official.Cargo.lock') if suffix else LOCK
    if not verify(CLI, spec, lock, selected):
        print('The ETAS installation does not match the selected configuration; verify the installation.', file=sys.stderr)
        return 1
    os.execv(str(CLI), [str(CLI), *sys.argv[1:]])


if __name__ == '__main__':
    raise SystemExit(main())
