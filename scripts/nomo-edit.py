#!/usr/bin/env python3
"""Launch the existing confirmed edit flow for an exclusive private workspace."""
import argparse
import io
import os
import re
import selectors
import signal
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent

def safe_read_question(value):
    """Mirror the read protocol's UTF-8 byte and terminal-safety bounds."""
    try:
        if not value.strip() or len(value.encode('utf-8')) > 128:return False
    except UnicodeEncodeError:return False
    return all(not (ord(c) < 32 or 127 <= ord(c) <= 159 or 0x200b <= ord(c) <= 0x200f or
                   0x2028 <= ord(c) <= 0x202e or 0x2060 <= ord(c) <= 0x2069 or ord(c) == 0xfeff) for c in value)


def format_check_capture(entry, env):
    """Render a bounded diagnostic prefix; known configured keys are removed."""
    text = bytes(entry['data']).decode('utf-8', errors='backslashreplace')
    for name in ('MINIMAX_API_KEY', 'NOMO_QWEN_SERVER_API_KEY', 'ETAS_HOST_MODEL_API_KEY'):
        value = env.get(name, '')
        if value:
            text = text.replace(value, '[REDACTED]')
            if entry['truncated']:
                for length in range(min(len(value) - 1, len(text)), 3, -1):
                    if text.endswith(value[:length]):
                        text = text[:-length] + '[REDACTED]'
                        break
    text = ''.join(ch if ch in '\n\t' or ord(ch) >= 32 and ord(ch) != 127 else '\\x%02x' % ord(ch) for ch in text)
    return text


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
        check = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), '--nomo-check-gate', *compose,
                 '--file', str(ROOT / 'config/nomo-check-compose.yaml'), 'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false',
                 '--workdir', '/edit-fixture', 'dev', '/usr/bin/timeout',
                 '--signal=TERM', '--kill-after=2s', '60s',
                 'python3', '-B', '/workspace/scripts/nomo-bounded-check.py', *args.check]
    return command, check, env


class RuntimeDiagnostic:
    """Bounded, advisory classification of known terminal diagnostics.

    The stream is untrusted: these observations never authorize a retry or a
    recovery decision. Keep only an enum and stage, not transcript content.
    """
    _length = b'error[analysis::UnhandledRuntimeError]: model generation failed: IncompleteResponse: OpenAI-compatible generation is incomplete (finish_reason=length)'
    _provider_503 = b'error[analysis::UnhandledRuntimeError]: model host boundary failed: OpenAI-compatible endpoint returned an error status (status=503)'
    _summary_bound = b'REFUSED edit completed; final answer requires 1..512 nonblank UTF-8 bytes'
    _history_summary_bound = b'REFUSED edit completed; final answer requires 1..1024 nonblank UTF-8 bytes'
    _read_refusals = {
        b'REFUSED expected bounded flat JSON string array': 'bounded_json_frame_refused',
        b'REFUSED invalid JSON': 'invalid_json_refused',
        b'REFUSED expected string fields': 'string_fields_refused',
        b'REFUSED invalid bounded delegated task': 'delegated_task_refused',
    }
    _stages = (b'read-plan', b'read-child', b'read-aggregate', b'edit-plan', b'edit-child', b'edit-aggregate')

    def __init__(self):
        self.stage = None
        self.post_edit = None
        self.plan_rejection = None
        self.categories = set()
        self.buffers = {'stdout': bytearray(), 'stderr': bytearray()}
        self.discard = {'stdout': False, 'stderr': False}

    def feed(self, stream, data):
        for byte in data:
            if byte == 10:
                if not self.discard[stream]:
                    self._line(bytes(self.buffers[stream]).removesuffix(b'\r'))
                self.buffers[stream].clear()
                self.discard[stream] = False
            elif not self.discard[stream]:
                if len(self.buffers[stream]) >= 512:
                    self.buffers[stream].clear()
                    self.discard[stream] = True
                else:
                    self.buffers[stream].append(byte)

    def _line(self, line):
        if line in (b'READ_PLAN_REJECTION blank', b'READ_PLAN_REJECTION length', b'READ_PLAN_REJECTION unsafe'):
            value = line[len(b'READ_PLAN_REJECTION '):].decode('ascii')
            if self.plan_rejection is None:self.plan_rejection = value
            elif self.plan_rejection != value:self.plan_rejection = 'unknown'
        if line in (b'POST_EDIT context', b'POST_EDIT aggregate', b'POST_EDIT events', b'POST_EDIT persist'):
            self.post_edit = line[len(b'POST_EDIT '):].decode('ascii')
        chat = re.fullmatch(rb'TURN [1-9][0-9]* STAGE (plan|child|aggregate) steps=[0-9]+ calls=[0-9]+ tokens=[0-9]+ tools=[0-9]+ scan=[0-9]+ reserved_steps=[0-9]+ reserved_calls=[0-9]+ reserved_tokens=[0-9]+ reserved_tools=[0-9]+ reserved_scan=[0-9]+', line)
        if chat:
            self.stage = 'chat-' + chat.group(1).decode('ascii')
        for stage in self._stages:
            if line == b'STAGE ' + stage or line.startswith(b'STAGE ' + stage + b' child-1 '):
                self.stage = stage.decode('ascii')
        if line == self._length:
            self.categories.add('incomplete_response_length')
        elif line == self._provider_503:
            self.categories.add('provider_http_503')
        elif line in (self._summary_bound, self._history_summary_bound):
            self.categories.add('summary_blank_or_over_limit')
        elif line in self._read_refusals:
            self.categories.add(self._read_refusals[line])

    def report(self, exit_code):
        if exit_code != 3:
            return
        category = next(iter(self.categories)) if len(self.categories) == 1 else 'unknown'
        print('Runtime diagnostic (observed terminal text, untrusted): last_stage_text=' +
              (self.stage or 'unknown') + ' text_marker=' + category + ' post_edit_text=' + (self.post_edit or 'unknown') + ' plan_rejection_text=' + (self.plan_rejection or 'unknown') +
              '. Inspect retained state; this is not a retry decision.', file=sys.stderr, flush=True)
        if category == 'summary_blank_or_over_limit' and self.post_edit == 'aggregate':
            print('The observed text may indicate a blank or over-limit summary. The edit may already be applied; inspect the file and session status before deciding what to do. Do not automatically retry.', file=sys.stderr, flush=True)


def run_owned(command, env, capture=None, input_data=None, diagnostic=None, *, capture_limit=4096, forward_output=True):
    """Forward interruption and wait for the owned terminal helper's cleanup."""
    requested = [0, 0.0]
    child = None
    selector = None
    writer = None
    input_errors = []
    forwarded = False
    old = {}
    if not isinstance(capture_limit,int) or not 1 <= capture_limit <= 4194304:
        raise ValueError('invalid capture limit')

    def interrupted(number, _frame):
        if not requested[0]:
            requested[:] = [number, time.monotonic()]

    try:
        for number in (signal.SIGINT, signal.SIGTERM):
            old[number] = signal.signal(number, interrupted)
        if requested[0]:
            return 128 + requested[0]
        child = subprocess.Popen(command, env=env, start_new_session=True,
                                 stdin=subprocess.PIPE if input_data is not None else None,
                                 stdout=subprocess.PIPE if capture is not None or diagnostic is not None else None,
                                 stderr=subprocess.PIPE if capture is not None or diagnostic is not None else None)
        if input_data is not None:
            def write_input():
                try:
                    child.stdin.write(input_data); child.stdin.close()
                except (OSError, ValueError) as error:
                    input_errors.append(error)
            writer = threading.Thread(target=write_input, daemon=True)
            writer.start()
        if capture is not None or diagnostic is not None:
            selector = selectors.DefaultSelector()
            for label, pipe, target in (('stdout', child.stdout, sys.stdout.buffer), ('stderr', child.stderr, sys.stderr.buffer)):
                if capture is not None:
                    capture[label] = {'data': bytearray(), 'truncated': False}
                selector.register(pipe, selectors.EVENT_READ, (label, target))
        def drain(timeout):
            if selector is None:
                time.sleep(timeout)
                return
            for key, _ in selector.select(timeout):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj); key.fileobj.close(); continue
                label, target = key.data
                # Write directly after flushing prior output: a failed buffered
                # flush can otherwise be retried by Python at interpreter exit
                # and replace the intended uncertain-status exit code.
                if forward_output:
                    target.flush()
                    try:
                        output_fd = target.fileno()
                    except (io.UnsupportedOperation, AttributeError):
                        target.write(data)
                        target.flush()
                    else:
                        view = memoryview(data)
                        while view:
                            written = os.write(output_fd, view)
                            if written <= 0:
                                raise OSError('terminal output did not advance')
                            view = view[written:]
                if diagnostic is not None:
                    diagnostic.feed(label, data)
                if capture is not None:
                    saved = capture[label]; room = max(0, capture_limit - len(saved['data']))
                    saved['data'].extend(data[:room])
                    if len(data) > room: saved['truncated'] = True
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
            drain(.05)
        if selector is not None:
            deadline = time.monotonic() + 3
            while selector.get_map() and time.monotonic() < deadline:
                drain(.05)
            if selector.get_map():
                print('Check output collection did not finish; inspect the operation.', file=sys.stderr, flush=True)
                return 125
        if writer is not None:
            writer.join(timeout=3)
            if writer.is_alive() or input_errors:
                print('Check output transfer was not confirmed.', file=sys.stderr, flush=True)
                return 125
        code = child.returncode
        if code == 125 or code < 0:
            print('Terminal cleanup is unconfirmed; inspect the operation before continuing.', file=sys.stderr, flush=True)
            return 125
        return 128 + requested[0] if requested[0] else code
    except BaseException:
        # A failed output sink, selector or observer must not let the owner
        # return while its terminal helper can still be executing an edit.
        # Ask that helper to run its normal container cleanup, and drain its
        # pipes without forwarding while waiting. If that cannot complete,
        # force-stop the helper and retain the uncertain result (125).
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except OSError:
                pass
            deadline = time.monotonic() + 18
            while child.poll() is None and time.monotonic() < deadline:
                if selector is None:
                    time.sleep(.05)
                    continue
                try:
                    for key, _ in selector.select(.05):
                        if not os.read(key.fileobj.fileno(), 65536):
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                except (OSError, ValueError):
                    time.sleep(.05)
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        try:
            os.write(sys.stderr.fileno(), b'Terminal output or collection failed; cleanup and outcome may be uncertain. Inspect retained state before continuing.\n')
        except (OSError, ValueError, AttributeError):
            pass
        return 125
    finally:
        if selector is not None:
            for key in list(selector.get_map().values()):
                key.fileobj.close()
            selector.close()
        for number, handler in old.items():
            signal.signal(number, handler)
        if requested[0]:
            try:
                print('Cancellation was requested.', file=sys.stderr, flush=True)
            except (OSError, ValueError):
                pass



def prepare_project_check(root, check, version=None):
    """Prepare a user-selected check without opening an edit operation store."""
    workspace = directory(root, 'workspace')
    info = workspace.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('workspace must be owned by you and inaccessible to other users')
    if not check or not check[0]:
        raise ValueError('provide a check command')
    version = version if version is not None else os.environ.get('NOMO_ETAS_VERSION', '0.2.2')
    if version not in ('0.2.2', '0.2.3', '0.2.4', '0.2.5'):
        raise ValueError('NOMO_ETAS_VERSION must be 0.2.2, 0.2.3, 0.2.4 or 0.2.5')
    overlay = {'0.2.2': 'config/etas-022-official-compose.yaml', '0.2.3': 'config/etas-023-official-compose.yaml', '0.2.4': 'config/etas-024-official-compose.yaml', '0.2.5': 'config/etas-025-official-compose.yaml'}[version]
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('ETAS_HOST_') and key not in
           ('NOMO_READ_MODEL_BASE_URL', 'NOMO_QWEN_SERVER_API_KEY', 'NOMO_READ_MODEL_NAME', 'MINIMAX_API_KEY',
            'NOMO_MODEL_REQUEST_DEADLINE_MS')}
    env['NOMO_EDIT_WORKSPACE_DIR'] = str(workspace)
    env['NOMO_ETAS_VERSION'] = version
    command = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), '--nomo-check-gate',
               'docker', 'compose', '--env-file', '/dev/null', '--file', str(ROOT / 'compose.yaml'),
               '--file', str(ROOT / overlay), '--file', str(ROOT / 'config/nomo-project-check-compose.yaml'),
               'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false',
               '--workdir', '/edit-fixture', 'dev', '/usr/bin/timeout',
               '--signal=TERM', '--kill-after=2s', '60s',
               'python3', '-B', '/workspace/scripts/nomo-bounded-check.py', *check]
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
    print('Running the requested check in the workspace (60-second limit; stdin is closed).', flush=True)
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
    print('Running the requested check in the edited workspace (60-second limit; stdin is closed).', flush=True)
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
