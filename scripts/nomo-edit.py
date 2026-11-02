#!/usr/bin/env python3
"""Launch the existing confirmed edit flow for an exclusive private workspace."""
import argparse
import os
import re
import signal
from pathlib import Path
import stat
import subprocess
import sys
import time

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
    task = getattr(args, 'task', None)
    provider = os.environ.get('NOMO_MODEL_PROVIDER', 'minimax')
    read_root = getattr(args, 'read_root', None)
    allowed = getattr(args, 'allow', None)
    if read_root is not None:
        read_root = directory(read_root, 'read root')
        if read_root == state or read_root in state.parents or state in read_root.parents:
            raise ValueError('read root and state must be separate, non-overlapping directories')
        names = allowed.split(',') if allowed is not None else []
        if (not 1 <= len(names) <= 2 or len(set(names)) != len(names) or
                any(not 1 <= len(name) <= 48 or len(name.split('/')) > 8 or
                    any(part in ('', '.', '..') or not re.fullmatch(r'[A-Za-z0-9._-]+', part)
                        for part in name.split('/')) for name in names)):
            raise ValueError('allow must name one or two distinct safe relative files')
        if task is None or not task.strip() or len(task) > 128 or not all(32 <= ord(c) <= 126 for c in task):
            raise ValueError('work task must be 1..128 printable ASCII characters, not only spaces')
    deadline = None
    if not args.id or not args.path:
        raise ValueError('id and path must be nonempty')
    if task is not None:
        if not task or args.target is not None or args.replacement is not None:
            raise ValueError('provide either a nonempty task or target and replacement')
        if provider == 'minimax':
            if not os.environ.get('MINIMAX_API_KEY'):
                raise ValueError('set MINIMAX_API_KEY to a MiniMax M Plan subscription key')
        elif provider == 'qwen':
            if not os.environ.get('NOMO_READ_MODEL_BASE_URL') or not os.environ.get('NOMO_QWEN_SERVER_API_KEY'):
                raise ValueError('set NOMO_READ_MODEL_BASE_URL and NOMO_QWEN_SERVER_API_KEY for Qwen')
        else:
            raise ValueError('NOMO_MODEL_PROVIDER must be minimax or qwen')
        raw_deadline = os.environ.get('NOMO_MODEL_REQUEST_DEADLINE_MS', '120000')
        if not raw_deadline.isascii() or not raw_deadline.isdigit() or len(raw_deadline) > 7:
            raise ValueError('NOMO_MODEL_REQUEST_DEADLINE_MS must be an integer from 2000 to 3600000')
        deadline = int(raw_deadline)
        if not 2000 <= deadline <= 3600000:
            raise ValueError('NOMO_MODEL_REQUEST_DEADLINE_MS must be an integer from 2000 to 3600000')
    elif not args.target or args.replacement is None:
        raise ValueError('provide either a nonempty task or target and replacement')
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
    version = os.environ.get('NOMO_ETAS_VERSION', '0.2.5' if task is not None and provider == 'minimax' else '0.2.2')
    if version not in ('0.2.2', '0.2.3', '0.2.4', '0.2.5'):
        raise ValueError('NOMO_ETAS_VERSION must be 0.2.2, 0.2.3, 0.2.4 or 0.2.5')
    cache = ROOT / '.etas'
    if cache.is_symlink():
        raise ValueError('project .etas mountpoint must not be a symlink')
    cache.mkdir(mode=0o700, exist_ok=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith('ETAS_HOST_')}
    if task is not None:
        env.pop('NOMO_QWEN_SERVER_API_KEY' if provider == 'minimax' else 'MINIMAX_API_KEY', None)
    else:
        env.pop('NOMO_QWEN_SERVER_API_KEY', None)
        env.pop('MINIMAX_API_KEY', None)
    env.update(NOMO_EDIT_WORKSPACE_DIR=str(workspace), NOMO_EDIT_STATE_DIR=str(state))
    if read_root is not None:
        env['NOMO_WORK_CONTEXT_DIR'] = str(read_root)
    if deadline is not None:
        env['NOMO_MODEL_REQUEST_DEADLINE_MS'] = str(deadline)
    overlay = {'0.2.2': 'config/etas-022-official-compose.yaml', '0.2.3': 'config/etas-023-official-compose.yaml', '0.2.4': 'config/etas-024-official-compose.yaml', '0.2.5': 'config/etas-025-official-compose.yaml'}[version]
    compose = ['docker', 'compose', '--env-file', '/dev/null', '--file', str(ROOT / 'compose.yaml'),
               '--file', str(ROOT / overlay),
               '--file', str(ROOT / 'config/etas-runtime-cache-compose.yaml'),
               '--file', str(ROOT / 'config/edit-operation-compose.yaml'),
               '--file', str(ROOT / 'config/nomo-edit-compose.yaml')]
    overlay_name = 'config/nomo-minimax-model-compose.yaml' if provider == 'minimax' else 'config/nomo-model-edit-compose.yaml'
    model_compose = compose + ['--file', str(ROOT / overlay_name)] if task is not None else compose
    if read_root is not None:
        model_compose += ['--file', str(ROOT / 'config/harness-work-compose.yaml')]
    native = (['--flow', 'harness_work', '--profile', 'harness-minimax-work' if provider == 'minimax' else 'harness-work', '--allow-effects', '--args',
               '--id', args.id, '--workspace', 'private-workspace', '--path', args.path, '--once', task, '--allow', allowed]
              if read_root is not None else
              ['--flow', 'harness_edit', '--profile', 'harness-minimax-edit' if provider == 'minimax' else 'harness-edit', '--allow-effects', '--args',
               '--id', args.id, '--workspace', 'private-workspace', '--path', args.path, '--once', task]
              if task is not None else
              ['--flow', 'edit_apply', '--profile', 'edit-apply', '--allow-effects', '--args',
               '--id', args.id, '--workspace', 'private-workspace', '--path', args.path,
               '--target', args.target, '--replacement', args.replacement])
    command = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), *model_compose,
               'run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
               'python3', '-B', '/workspace/scripts/nomo-verified-etas.py', 'run', '/workspace', *native]
    check = None
    if args.check:
        check = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), *compose,
                 '--file', str(ROOT / 'config/nomo-check-compose.yaml'), 'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false',
                 '--workdir', '/edit-fixture', 'dev', '/usr/bin/timeout',
                 '--signal=TERM', '--kill-after=2s', '60s', *args.check]
    return command, check, env


def run_owned(command, env):
    """Forward interruption and wait for the owned terminal helper's cleanup."""
    requested = [0, 0.0]
    child = None
    forwarded = False
    old = {}

    def interrupted(number, _frame):
        if not requested[0]:
            requested[:] = [number, time.monotonic()]

    try:
        for number in (signal.SIGINT, signal.SIGTERM):
            old[number] = signal.signal(number, interrupted)
        if requested[0]:
            return 128 + requested[0]
        child = subprocess.Popen(command, env=env, start_new_session=True)
        while child.poll() is None:
            if requested[0] and not forwarded:
                try:
                    os.killpg(child.pid, requested[0])
                except ProcessLookupError:
                    pass
                except OSError:
                    print('Terminal cleanup is unconfirmed; inspect the operation before continuing.', file=sys.stderr, flush=True)
                    return 125
                forwarded = True
            if requested[0] and time.monotonic() - requested[1] > 18:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError:
                    print('Terminal cleanup is unconfirmed; inspect the operation before continuing.', file=sys.stderr, flush=True)
                    return 125
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
                print('Terminal cleanup is unconfirmed; inspect the operation before continuing.', file=sys.stderr, flush=True)
                return 125
            time.sleep(.05)
        code = child.returncode
        if code == 125 or code < 0:
            print('Terminal cleanup is unconfirmed; inspect the operation before continuing.', file=sys.stderr, flush=True)
            return 125
        return 128 + requested[0] if requested[0] else code
    finally:
        for number, handler in old.items():
            signal.signal(number, handler)
        if requested[0]:
            print('Cancellation was requested.', file=sys.stderr, flush=True)



def prepare_project_check(root, check):
    """Prepare a user-selected check without opening an edit operation store."""
    workspace = directory(root, 'workspace')
    info = workspace.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('workspace must be owned by you and inaccessible to other users')
    if not check or not check[0]:
        raise ValueError('provide a check command')
    version = os.environ.get('NOMO_ETAS_VERSION', '0.2.2')
    if version not in ('0.2.2', '0.2.3', '0.2.4', '0.2.5'):
        raise ValueError('NOMO_ETAS_VERSION must be 0.2.2, 0.2.3, 0.2.4 or 0.2.5')
    overlay = {'0.2.2': 'config/etas-022-official-compose.yaml', '0.2.3': 'config/etas-023-official-compose.yaml', '0.2.4': 'config/etas-024-official-compose.yaml', '0.2.5': 'config/etas-025-official-compose.yaml'}[version]
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('ETAS_HOST_') and key not in
           ('NOMO_READ_MODEL_BASE_URL', 'NOMO_QWEN_SERVER_API_KEY', 'NOMO_READ_MODEL_NAME', 'MINIMAX_API_KEY',
            'NOMO_MODEL_REQUEST_DEADLINE_MS')}
    env['NOMO_EDIT_WORKSPACE_DIR'] = str(workspace)
    command = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'),
               'docker', 'compose', '--env-file', '/dev/null', '--file', str(ROOT / 'compose.yaml'),
               '--file', str(ROOT / overlay), '--file', str(ROOT / 'config/nomo-project-check-compose.yaml'),
               'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false',
               '--workdir', '/edit-fixture', 'dev', '/usr/bin/timeout',
               '--signal=TERM', '--kill-after=2s', '60s', *check]
    return command, env


def project_check_main(argv):
    parser = argparse.ArgumentParser(description='Run a selected offline check in a private workspace.',
                                     epilog='Checks can modify the workspace. They do not establish an edit or session outcome.')
    parser.add_argument('--root', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER, help='check command and arguments after --')
    args = parser.parse_args(argv)
    check = args.command[1:] if args.command[:1] == ['--'] else args.command
    try:
        command, env = prepare_project_check(args.root, check)
    except (OSError, ValueError) as error:
        print('Cannot start check: ' + str(error), file=sys.stderr)
        return 64
    print('Running the requested check in the workspace (60-second limit).', flush=True)
    result = run_owned(command, env)
    if result:
        print('Check failed or could not be completed (exit ' + str(result) + ').', file=sys.stderr, flush=True)
        return result
    print('Check passed.', flush=True)
    return 0



def prepare_edit_status(state_path, operation_id, path):
    """Inspect an existing operation record without reopening the workspace."""
    state = directory(state_path, 'state')
    info = state.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('state must be owned by you with mode 0700')
    if not operation_id or not path:
        raise ValueError('id and path must be nonempty')
    for suffix in ('', '-wal', '-shm', '-journal'):
        entry = state / ('edit.sqlite3' + suffix)
        if entry.is_symlink():
            raise ValueError('state database and sidecars must not be symlinks')
        if entry.exists() and (not entry.is_file() or entry.stat().st_nlink != 1):
            raise ValueError('state database and sidecars must be regular files without hardlinks')
    if not (state / 'edit.sqlite3').is_file():
        raise ValueError('existing edit.sqlite3 required')
    version = os.environ.get('NOMO_ETAS_VERSION', '0.2.2')
    if version not in ('0.2.2', '0.2.3', '0.2.4', '0.2.5'):
        raise ValueError('NOMO_ETAS_VERSION must be 0.2.2, 0.2.3, 0.2.4 or 0.2.5')
    cache = ROOT / '.etas'
    if cache.is_symlink():
        raise ValueError('project .etas mountpoint must not be a symlink')
    cache.mkdir(mode=0o700, exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('ETAS_HOST_') and key not in
           ('NOMO_READ_MODEL_BASE_URL', 'NOMO_QWEN_SERVER_API_KEY', 'NOMO_READ_MODEL_NAME', 'MINIMAX_API_KEY',
            'NOMO_MODEL_REQUEST_DEADLINE_MS')}
    env['NOMO_EDIT_STATE_DIR'] = str(state)
    overlay = {'0.2.2': 'config/etas-022-official-compose.yaml', '0.2.3': 'config/etas-023-official-compose.yaml', '0.2.4': 'config/etas-024-official-compose.yaml', '0.2.5': 'config/etas-025-official-compose.yaml'}[version]
    command = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'),
               'docker', 'compose', '--env-file', '/dev/null', '--file', str(ROOT / 'compose.yaml'),
               '--file', str(ROOT / overlay), '--file', str(ROOT / 'config/etas-runtime-cache-compose.yaml'),
               '--file', str(ROOT / 'config/nomo-edit-status-compose.yaml'),
               'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
               'python3', '-B', '/workspace/scripts/nomo-verified-etas.py', 'run', '/workspace',
               '--flow', 'edit_status', '--profile', 'edit-status', '--allow-effects', '--args',
               '--id', operation_id, '--workspace', 'private-workspace', '--path', path]
    return command, env


def edit_status_main(argv):
    parser = argparse.ArgumentParser(description='Show the recorded status of an edit in its private operation state.',
                                     epilog='Use only when the operation is no longer running. SQLite opens the state read-write for bookkeeping. This does not inspect the current workspace file or retry an edit.')
    parser.add_argument('--state', required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--path', required=True)
    args = parser.parse_args(argv)
    try:
        command, env = prepare_edit_status(args.state, args.id, args.path)
    except (OSError, ValueError) as error:
        print('Cannot show edit status: ' + str(error), file=sys.stderr)
        return 64
    return run_owned(command, env)


def main(argv=None, work=False):
    parser = argparse.ArgumentParser(description='Edit one file in an exclusive private workspace with preview and confirmation.', epilog='Use an exclusive workspace without symlinks or concurrent writers. State must be a separate empty mode-0700 directory; preserve it after an uncertain result.')
    parser.add_argument('--root', required=True)
    parser.add_argument('--state', required=True, help='empty private directory for one durable operation')
    parser.add_argument('--id', required=True)
    parser.add_argument('--path', required=True)
    parser.add_argument('--target')
    parser.add_argument('--replacement')
    parser.add_argument('--once', dest='task', help='model task; sends the selected file to the configured model')
    if work:
        parser.add_argument('--read-root', required=True, help='read-only context directory, separate from state')
        parser.add_argument('--allow', required=True, help='one or two distinct relative context files')
    parser.add_argument('--check', nargs=argparse.REMAINDER, help='optional check command and arguments; put this option last')
    args = parser.parse_args(argv)
    if args.check == []:
        parser.error('--check requires a command')
    try:
        command, check, env = prepare(args, sys.stdin.isatty(), sys.stdout.isatty())
    except (OSError, ValueError) as error:
        print('Cannot start edit: ' + str(error), file=sys.stderr)
        return 64
    if args.task is not None:
        if os.environ.get('NOMO_MODEL_PROVIDER', 'minimax') == 'minimax':
            print('MiniMax M Plan (China): MiniMax-M3.1-Flash; thinking is enabled and counts toward the output allowance. '
                  'Review the complete edit preview carefully; ETAS 0.2.4 does not expose the provider finish reason.', flush=True)
        if work:
            print('Work may send the selected context, edit file and task to the model before write confirmation. '
                  'The read root is mounted read-only; the allowlist is enforced by Nomo, not per-file mounts. '
                  'Links and concurrent changes can affect what is read. One-shot only; no session resume.', flush=True)
            print('Work allows up to 7 model calls and 47104 requested output tokens; actual usage may differ.', flush=True)
        print('Model requests have a ' + env.get('NOMO_MODEL_REQUEST_DEADLINE_MS', '120000') +
              '-millisecond deadline each; no automatic retries.', flush=True)
        print('A busy model service may queue requests; waiting counts toward each deadline.', flush=True)
    edited = run_owned(command, env)
    if edited != 0:
        if args.task is not None:
            print('Model edit stopped; the launcher did not classify the cause. '
                  'If a request was sent, its remote outcome may be unknown. '
                  'Inspect the file and edit status before trying again.', file=sys.stderr, flush=True)
        return edited
    if not check:
        print('Edit completed; no check was requested.', flush=True)
        return 0
    print('Running the requested check in the edited workspace (60-second limit).', flush=True)
    check_env = {key: value for key, value in env.items() if key not in
                 ('NOMO_READ_MODEL_BASE_URL', 'NOMO_QWEN_SERVER_API_KEY', 'NOMO_READ_MODEL_NAME', 'MINIMAX_API_KEY',
                  'NOMO_MODEL_REQUEST_DEADLINE_MS', 'NOMO_WORK_CONTEXT_DIR')}
    checked = run_owned(check, check_env)
    if checked != 0:
        print('Check failed or could not be completed (exit ' + str(checked) + ').', file=sys.stderr, flush=True)
        return checked
    print('Check passed.', flush=True)
    return 0


if __name__ == '__main__':
    if sys.argv[1:2] == ['--work']:
        raise SystemExit(main(sys.argv[2:], work=True))
    if sys.argv[1:2] == ['--check-only']:
        raise SystemExit(project_check_main(sys.argv[2:]))
    if sys.argv[1:2] == ['--status-only']:
        raise SystemExit(edit_status_main(sys.argv[2:]))
    raise SystemExit(main())
