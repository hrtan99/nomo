#!/usr/bin/env python3
"""Launch the existing confirmed edit flow for an exclusive private workspace."""
import argparse
import os
from pathlib import Path
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def directory(raw, name):
    path = Path(raw)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise ValueError(name + ' must be an existing absolute directory with a non-symlink leaf')
    return path.resolve(strict=True)


def prepare(args, stdin_tty, stdout_tty):
    if not stdin_tty or not stdout_tty:
        raise ValueError('editing requires an interactive terminal for both confirmation prompts')
    workspace = directory(args.root, 'workspace')
    state = directory(args.state, 'state')
    workspace_info = workspace.stat()
    if workspace_info.st_uid != os.getuid() or stat.S_IMODE(workspace_info.st_mode) & 0o077:
        raise ValueError('workspace must be owned by you and inaccessible to other users')
    if workspace == state or workspace in state.parents or state in workspace.parents:
        raise ValueError('state and workspace must be separate, non-overlapping directories')
    info = state.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or any(state.iterdir()):
        raise ValueError('state must be an empty directory owned by you with mode 0700')
    if not args.id or not args.path or not args.target:
        raise ValueError('id, path and target must be nonempty')
    selected = Path(args.path)
    if selected.is_absolute() or '..' in selected.parts or '\\' in args.path or '\0' in args.path:
        raise ValueError('file must be a relative path inside the workspace')
    current = workspace
    for part in selected.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('the selected file path must not contain symlinks')
    if not current.is_file():
        raise ValueError('the selected file must be an existing regular file')
    cache = ROOT / '.etas'
    if cache.is_symlink():
        raise ValueError('project .etas mountpoint must not be a symlink')
    cache.mkdir(mode=0o700, exist_ok=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith('ETAS_HOST_')}
    env.update(NOMO_EDIT_WORKSPACE_DIR=str(workspace), NOMO_EDIT_STATE_DIR=str(state))
    compose = ['docker', 'compose', '--env-file', '/dev/null', '--file', str(ROOT / 'compose.yaml'),
               '--file', str(ROOT / 'config/etas-022-official-compose.yaml'),
               '--file', str(ROOT / 'config/etas-runtime-cache-compose.yaml'),
               '--file', str(ROOT / 'config/edit-operation-compose.yaml'),
               '--file', str(ROOT / 'config/nomo-edit-compose.yaml')]
    command = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), *compose,
               'run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
               'python3', '-B', '/workspace/scripts/nomo-verified-etas.py', 'run', '/workspace',
               '--flow', 'edit_apply', '--profile', 'edit-apply', '--allow-effects', '--args',
               '--id', args.id, '--workspace', 'private-workspace', '--path', args.path,
               '--target', args.target, '--replacement', args.replacement]
    check = None
    if args.check:
        check = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), *compose,
                 'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false',
                 '--workdir', '/edit-fixture', 'dev', '/usr/bin/timeout',
                 '--signal=TERM', '--kill-after=2s', '60s', *args.check]
    return command, check, env


def main(argv=None):
    parser = argparse.ArgumentParser(description='Edit one file in an exclusive private workspace with preview and confirmation.', epilog='Use an exclusive workspace without symlinks or concurrent writers. State must be a separate empty mode-0700 directory; preserve it after an uncertain result.')
    parser.add_argument('--root', required=True)
    parser.add_argument('--state', required=True, help='empty private directory for one durable operation')
    parser.add_argument('--id', required=True)
    parser.add_argument('--path', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--replacement', required=True)
    parser.add_argument('--check', nargs=argparse.REMAINDER, help='optional check command and arguments; put this option last')
    args = parser.parse_args(argv)
    if args.check == []:
        parser.error('--check requires a command')
    try:
        command, check, env = prepare(args, sys.stdin.isatty(), sys.stdout.isatty())
    except (OSError, ValueError) as error:
        print('Cannot start edit: ' + str(error), file=sys.stderr)
        return 64
    edited = subprocess.run(command, env=env, check=False)
    if edited.returncode != 0:
        return edited.returncode
    if not check:
        print('Edit completed; no check was requested.', flush=True)
        return 0
    print('Running the requested check in the edited workspace (60-second limit).', flush=True)
    checked = subprocess.run(check, env=env, check=False)
    if checked.returncode != 0:
        print('Check failed or could not be completed (exit ' + str(checked.returncode) + ').', file=sys.stderr, flush=True)
        return checked.returncode if checked.returncode > 0 else 1
    print('Check passed.', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
