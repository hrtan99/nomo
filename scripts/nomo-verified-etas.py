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


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(cli, spec_path, lock_path, selected):
    try:
        spec = json.loads(spec_path.read_text())
        if selected != 'latest022' or spec['selector'] != selected:
            return False
        if cli.is_symlink() or not cli.is_file() or digest(cli) != spec['verified_seed_binary_sha256']:
            return False
        if digest(lock_path) != spec['cargo_lock_sha256']:
            return False
        version = subprocess.run([str(cli), '--version'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        return version.returncode == 0 and version.stdout == b'etas 0.2.2\n' and not version.stderr
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return False


def main():
    if not verify(CLI, SPEC, LOCK, os.environ.get('NOMO_NORMAL_GRAPH')):
        print('The ETAS 0.2.2 installation does not match the selected configuration; verify the installation.', file=sys.stderr)
        return 1
    os.execv(str(CLI), [str(CLI), *sys.argv[1:]])


if __name__ == '__main__':
    raise SystemExit(main())
