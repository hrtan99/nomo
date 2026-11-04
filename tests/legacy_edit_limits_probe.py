#!/usr/bin/env python3
"""Verify legacy edit preparation rejects oversized data before confirmation."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory(prefix='nomo-legacy-edit-limits-') as directory:
        project = Path(directory) / 'project'
        shutil.copytree(ROOT, project, ignore=shutil.ignore_patterns('.git', '.etas', 'tmp', '__pycache__'))
        (project / '.etas').mkdir()
        main_file = project / 'src/nomo/main.es'
        source = main_file.read_text().replace('module nomo.main;', 'module nomo.main;\nimport nomo.tools.edit_file.prepare_original_legacy;', 1)
        too_large, prefix, addition = 'x' * 16385, 'x' * 8192, 'y' * 8193
        source += '\npublic flow legacy_size_probe(args: Array<string>) -> i32 {\n'
        source += '    match prepare_original_legacy("note.txt", "' + too_large + '", "x", "y") { Err(_) => {} Ok(_) => { return 4; } }\n'
        source += '    match prepare_original_legacy("note.txt", "old", "old", "' + too_large + '") { Err(_) => {} Ok(_) => { return 1; } }\n'
        source += '    match prepare_original_legacy("note.txt", "' + prefix + 'old", "old", "' + addition + '") { Err(_) => {} Ok(_) => { return 2; } }\n'
        source += '    match prepare_original_legacy("note.txt", "old", "old", "new") { Ok(_) => {} Err(_) => { return 3; } }\n    return 0;\n}\n'
        main_file.write_text(source)
        env = dict(os.environ, NOMO_ETAS_GRAPH='026-v68')
        command = ['docker', 'compose', '--env-file', '/dev/null', '-f', 'compose.yaml', '-f', 'config/etas-026-official-compose.yaml', '-f', 'config/etas-runtime-cache-compose.yaml', 'run', '--rm', '--no-deps', '-T', 'dev', 'python3', '-B', '/workspace/scripts/nomo-verified-etas.py', 'run', '/workspace', '--flow', 'legacy_size_probe', '--profile', 'foundation', '--allow-effects']
        result = subprocess.run(command, cwd=project, env=env, text=True, capture_output=True, timeout=120)
        assert result.returncode == 0 and '"value":"0"' in result.stdout.replace(' ', ''), (result.stdout, result.stderr)
        print('PASS legacy oversized original/replacement/result refused before confirmation; bounded edit accepted')


if __name__ == '__main__':
    main()
