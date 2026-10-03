#!/usr/bin/env python3
"""Verify the explicitly selected normal graph in an owned regression copy."""
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
        for name in ['src', 'tests', 'scripts', 'examples']:
            shutil.copytree(ROOT / name, project / name, ignore=shutil.ignore_patterns('__pycache__'))
        inputs = ['etas.toml', 'etas.lock', 'patches/etas-003/Cargo.lock']
        if env.get('NOMO_NORMAL_GRAPH', 'etas0013') == 'etas0013':
            inputs += ['patches/etas-0013/' + name + '.Cargo.lock'
                       for name in ('core', 'frontend', 'interpreter', 'cli')]
        for name in inputs:
            target = project / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        subprocess.run(['bash', str(project / 'scripts/model-001-verify.sh')], env=env, check=True, timeout=300)


if __name__ == '__main__':
    main()
