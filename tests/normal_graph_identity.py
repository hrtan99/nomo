#!/usr/bin/env python3
"""Explicit, provenance-checked normal graph selection for existing regressions."""
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
LEGACY_CLI_SHA256 = '0dead4ce2fd435a2c711629a7197bc0da041ed7ad2ff241f2f4f9b3ef17fbaad'
LEGACY_LOCK_SHA256 = '3e8bfec4e09a57b52bcf4bb29f9e8c394eb91e23eadf1eb8287de9a2ff8e60d1'
PROJECT_LOCK_SHA256 = 'f127a6476f3e3295be20913c92c2d45d32a6d84625d33ac8d530b7cf5e78c33b'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selected_graph():
    selected = os.environ.get('NOMO_NORMAL_GRAPH', 'latest')
    if selected not in ('latest', 'latest009', 'legacy', 'etas0013'):
        raise RuntimeError('NOMO_NORMAL_GRAPH must be latest, latest009, legacy or etas0013')
    return selected


def bootstrap_path():
    names = {'latest': 'etas-latest-cli-bootstrap.py', 'latest009': 'etas-009-cli-bootstrap.py', 'etas0013': 'etas-0013-cli-bootstrap.py',
             'legacy': 'etas-003-cli-bootstrap.sh'}
    return ROOT / 'scripts' / names[selected_graph()]


def verify_cli():
    selected = selected_graph()
    located = shutil.which('etas')
    if located is None:
        raise RuntimeError('Etas CLI is not installed on PATH')
    cli = Path(located)
    if digest(ROOT / 'etas.lock') != PROJECT_LOCK_SHA256:
        raise RuntimeError('normal project lock drift')
    if selected == 'legacy':
        if digest(cli) != LEGACY_CLI_SHA256:
            raise RuntimeError('legacy CLI hash drift')
        if digest(ROOT / 'patches/etas-003/Cargo.lock') != LEGACY_LOCK_SHA256:
            raise RuntimeError('legacy Cargo lock drift')
    else:
        spec = importlib.util.spec_from_file_location('normal_' + selected + '_bootstrap', bootstrap_path())
        bootstrap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bootstrap)
        # This checks the exact four pins, locks, origins and built/installed
        # binary identity without changing the read-only development cache.
        bootstrap.verify(read_only=True)
        if cli.resolve() != bootstrap.INSTALLED.resolve():
            raise RuntimeError('PATH does not select the verified installed CLI')
    print('PASS normal_graph_identity ' + selected + ' ' + digest(cli), flush=True)
    return cli


if __name__ == '__main__':
    verify_cli()
