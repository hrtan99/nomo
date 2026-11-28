#!/usr/bin/env python3
"""Provenance-checked selection of this checkout's current Etas toolchain."""
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
PROJECT_LOCK_SHA256 = 'f127a6476f3e3295be20913c92c2d45d32a6d84625d33ac8d530b7cf5e78c33b'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selected_graph():
    selected = os.environ.get('NOMO_NORMAL_GRAPH', 'latest02413')
    if selected != 'latest02413':
        raise RuntimeError('NOMO_NORMAL_GRAPH must be latest02413')
    return selected


def bootstrap_path():
    selected_graph()
    return ROOT / 'scripts/etas-02413-official-cli-bootstrap.py'


def bootstrap_evidence_paths():
    return [bootstrap_path(), ROOT / 'scripts/etas-official-cli-common.py',
            ROOT / 'config/etas-official-legacy-bridge.json',
            ROOT / 'config/etas-02413-official.json',
            ROOT / 'config/etas-02413-official.Cargo.lock']


def verify_cli():
    selected = selected_graph()
    located = shutil.which('etas')
    if located is None:
        raise RuntimeError('Etas CLI is not installed on PATH')
    cli = Path(located)
    if digest(ROOT / 'etas.lock') != PROJECT_LOCK_SHA256:
        raise RuntimeError('normal project lock drift')
    spec = importlib.util.spec_from_file_location('normal_' + selected + '_bootstrap', bootstrap_path())
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    bootstrap.verify(read_only=True)
    if cli.resolve() != bootstrap.INSTALLED.resolve():
        raise RuntimeError('PATH does not select the verified installed CLI')
    print('PASS normal_graph_identity ' + selected + ' ' + digest(cli), flush=True)
    return cli


if __name__ == '__main__':
    verify_cli()
