#!/usr/bin/env python3
"""Verify accepted-graph TOOL-001A and existing product checks in an owned copy."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    subprocess.run(['python3', '-B', str(ROOT / 'tests/tool_workspace_probe.py')], env=env, check=True, timeout=90)
    with tempfile.TemporaryDirectory(prefix='nomo-tool001a-regression-') as directory:
        project = Path(directory)
        for name in ['src', 'packages', 'tests', 'scripts', 'examples']:
            shutil.copytree(ROOT / name, project / name, ignore=shutil.ignore_patterns('__pycache__'))
        for name in ['etas.toml', 'etas.lock', 'patches/etas-003/Cargo.lock']:
            target = project / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        subprocess.run(['bash', str(project / 'scripts/model-001-verify.sh')], env=env, check=True, timeout=300)


if __name__ == '__main__':
    main()
