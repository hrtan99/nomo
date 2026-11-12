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
VERSIONS = {'latest022': '0.2.2', 'latest023': '0.2.3', 'latest024': '0.2.4', 'latest025': '0.2.5', 'latest026': '0.2.6', 'latest026v68': '0.2.6', 'latest030': '0.3.0', 'latest041': '0.4.1', 'latest0120': '0.12.0', 'latest0121': '0.12.1', 'latest0130': '0.13.0', 'latest0131': '0.13.1', 'latest0132': '0.13.2', 'latest0133': '0.13.3'}


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
    selected = {'026-20261103-a': 'latest026', '026-v68': 'latest026v68', '030-pr67': 'latest030', '041-20261105-a': 'latest041', '0120-20261110-a': 'latest0120', '0121-20261111-a': 'latest0121', '0130-20261111-a': 'latest0130', '0131-20261111-a': 'latest0131', '0132-20261112-a': 'latest0132', '0133-20261112-a': 'latest0133'}.get(os.environ.get('NOMO_NORMAL_GRAPH'), os.environ.get('NOMO_NORMAL_GRAPH'))
    suffix = {'latest022': '022', 'latest023': '023', 'latest024': '024', 'latest025': '025', 'latest026': '026', 'latest026v68': '026-v68', 'latest030': '030', 'latest041': '041', 'latest0120': '0120', 'latest0121': '0121', 'latest0130': '0130', 'latest0131': '0131', 'latest0132': '0132'}.get(selected)
    spec = Path('/workspace/config/etas-latest-main.json') if selected == 'latest0133' else Path('/workspace/config/etas-' + suffix + '-official.json') if suffix else SPEC
    lock = Path('/workspace/config/etas-latest.Cargo.lock') if selected == 'latest0133' else Path('/workspace/config/etas-' + suffix + '-official.Cargo.lock') if suffix else LOCK
    cli = Path('/home/nomo/.cargo/etas-030-pr67/bin/etas') if selected == 'latest030' else CLI
    if not verify(cli, spec, lock, selected):
        print('The ETAS installation does not match the selected configuration; verify the installation.', file=sys.stderr)
        return 1
    from nomo_model_transport import run
    return run(cli, sys.argv[1:])


if __name__ == '__main__':
    raise SystemExit(main())
