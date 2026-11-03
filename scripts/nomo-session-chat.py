#!/usr/bin/env python3
"""A terminal loop over an existing ID-addressed session."""
import argparse
import importlib.util
import os
import re
import secrets
import signal
import shlex
import select
import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('edit_launcher', ROOT / 'scripts/nomo-edit.py')
edit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edit)


# A producer that leaves stdin open must not keep a one-shot run waiting forever.
PIPE_INPUT_TIMEOUT = 2.0
PIPE_PAYLOAD_BYTES = 512


def piped_question(stream):
    """Read exactly one bounded UTF-8 line and require EOF before dispatch."""
    fd = stream.fileno()
    end = time.monotonic() + PIPE_INPUT_TIMEOUT
    data = bytearray()
    while True:
        remaining = end - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise ValueError('piped input must reach EOF within 2 seconds')
        chunk = os.read(fd, PIPE_PAYLOAD_BYTES + 3 - len(data))
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > PIPE_PAYLOAD_BYTES + 2:
            raise ValueError('piped question exceeds 512 UTF-8 bytes')
    if data.endswith(b'\n'):
        del data[-1:]
        if data.endswith(b'\r'):
            del data[-1:]
    if len(data) > PIPE_PAYLOAD_BYTES:
        raise ValueError('piped question exceeds 512 UTF-8 bytes')
    if any(byte < 32 or byte == 127 for byte in data):
        raise ValueError('piped input must contain exactly one printable line')
    try:
        question = data.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('piped input must be valid UTF-8') from error
    if not question.strip():
        raise ValueError('piped question must be non-empty')
    return question

class StartIdObserver:
    """Capture only the first line produced by our session-id start process."""
    def __init__(self):
        self.pending = bytearray()
        self.identifier = None
        self.finished = False

    def feed(self, stream, data):
        if stream != 'stdout' or self.finished:
            return
        line, separator, _rest = data.partition(b'\n')
        self.pending.extend(line)
        if len(self.pending) > 64:
            self.finished = True
            self.pending.clear()
            return
        if separator:
            match = re.fullmatch(rb'SESSION ID ([0-9a-f]{32})\r?', self.pending)
            if match:
                self.identifier = match.group(1).decode('ascii')
            self.pending.clear()
            self.finished = True

class NaturalObserver(StartIdObserver):
    def __init__(self, allowed):
        super().__init__()
        self.allowed = allowed
        self.buffer = bytearray()
        self.route = None
        self.deferred = None

    def feed(self, stream, data):
        super().feed(stream, data)
        if stream != 'stdout':return
        self.buffer.extend(data)
        while b'\n' in self.buffer:
            line, _, remainder = self.buffer.partition(b'\n');self.buffer = bytearray(remainder)
            try: fields = line.decode('utf-8', 'strict').rstrip('\r').split(' ')
            except UnicodeDecodeError: continue
            if len(fields)==4 and fields[:2]==['NATURAL','WORK'] and fields[2] in ('work','followup') and (edit.safe_path(fields[3]) and (fields[3] in self.allowed or '*' in self.allowed)):
                self.route = (fields[2], fields[3])
            elif fields == ['NATURAL','PAGE']:self.deferred = 'page'
            elif fields == ['NATURAL','PAGE','LIMIT']:self.deferred = 'page-limit'
            elif fields == ['NATURAL','DELEGATE']:self.deferred = 'read'
            elif fields == ['NATURAL','DELEGATE','LIMIT']:self.deferred = 'limit'


def show_resume(args, *, show_id):
    if show_id:
        print('SESSION ID ' + args.id, flush=True)
    if args.events_policy_dir is None:
        print('Read turns and bounded work use this session; each edit requires fresh confirmations.', flush=True)
    else:
        print('Event recording supports successive work operations, each with an optional check and fresh approval; each new-session work reserves up to 7 model calls and 61440 output tokens.', flush=True)
    policy = '' if args.events_policy_dir is None else ' --events-policy-dir ' + shlex.quote(args.events_policy_dir)
    print('Resume: nomo-read.sh session-id resume --sessions-dir ' + shlex.quote(args.sessions_dir)
          + ' --id ' + shlex.quote(args.id) + ' --root DIR --allow FILE' + policy + ' --once QUESTION', flush=True)
    interactive = [str(ROOT / 'scripts/nomo-read.sh'), 'session-chat', '--sessions-dir=' + args.sessions_dir,
                   '--id=' + args.id, '--root=' + args.root, '--discover' if args.discover else '--allow=' + args.allow]
    if args.discover: interactive.append('--page=' + str(args.page))
    if args.events_policy_dir is not None:
        interactive.append('--events-policy-dir=' + args.events_policy_dir)
    if args.check is not None:
        interactive.extend(['--check', *args.check])
    print('Resume interactive: ' + shlex.join(interactive), flush=True)

def show_status_hint(args, identifier):
    if identifier is None:
        print('Session ID was not confirmed; inspect the retained sessions directory.', file=sys.stderr, flush=True)
        return
    command = [str(ROOT / 'scripts/nomo-read.sh'), 'session-id', 'status',
               '--sessions-dir=' + args.sessions_dir, '--id=' + identifier]
    if args.events_policy_dir is not None:
        command.append('--events-policy-dir=' + args.events_policy_dir)
    print('Inspect status: ' + shlex.join(command), file=sys.stderr, flush=True)

def session_state(args):
    spec = importlib.util.spec_from_file_location('session_id', ROOT / 'scripts/nomo-session-id.py')
    registry = importlib.util.module_from_spec(spec); spec.loader.exec_module(registry)
    base, root_fd = registry.registry(args.sessions_dir)
    try: return registry.session(root_fd, base, args.id, False)
    finally: os.close(root_fd)


def abandon_stopped_work(args, operation_id, action):
    # Called only by the live owner after the matching transport returned 130.
    state = session_state(args)
    policy_spec = importlib.util.spec_from_file_location('event_policy', ROOT / 'scripts/nomo-event-policy.py')
    policy = importlib.util.module_from_spec(policy_spec); policy_spec.loader.exec_module(policy)
    policy_dir, _, binding = policy.read_private(args.events_policy_dir)
    fd = os.open(state / '.nomo-session.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        edit.check_history_lock(fd)
        env = {k:v for k,v in os.environ.items() if not k.startswith('ETAS_HOST_') and k not in ('MINIMAX_API_KEY', 'NOMO_QWEN_SERVER_API_KEY')}
        env.update(NOMO_SESSION_STATE=str(state), NOMO_EVENT_POLICY_DIR=str(policy_dir), NOMO_ETAS_VERSION=os.environ.get('NOMO_ETAS_VERSION', '0.2.6'))
        compose = ['docker', 'compose', '--env-file', '/dev/null']
        for name in ('compose.yaml', 'config/etas-' + env['NOMO_ETAS_VERSION'].replace('.', '') + '-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml', 'config/nomo-read-session-compose.yaml', 'config/nomo-event-policy-work-compose.yaml'):
            compose += ['--file', str(ROOT / name)]
        native = ['python3', '-B', '/workspace/scripts/nomo-event-policy-mount-bootstrap.py', binding, 'run', '/workspace', '--flow', 'recoverable_work_abandon' if action == 'work' else 'recoverable_followup_abandon', '--profile', 'nomo-read-events-status', '--allow-effects', '--args', binding, operation_id]
        command = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), *compose, 'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', '--workdir', '/session-state', 'dev', *native]
        return edit.run_owned(command, env)
    finally: os.close(fd)

def recovery_ready(code, signals, proof, closed):
    return code == 130 and signals == [signal.SIGINT] and proof == b'clean-sigint\n' and closed

def offer_recovery(args, operation_id, action):
    print('The interrupted edit or check may have had effects. Inspect the workspace before continuing; saved records and budgets remain.', flush=True)
    try: answer = input('Abandon this interrupted operation and continue this session? [y/N] ').strip().lower()
    except (EOFError, KeyboardInterrupt): return False
    if answer not in ('y', 'yes'): return False
    try: return abandon_stopped_work(args, operation_id, action) == 0
    except (OSError, ValueError) as error:
        print('Recovery decision was not confirmed: ' + str(error), file=sys.stderr, flush=True)
        return False

def chat_turn(args, question, starting, natural, tty):
    command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'init' if question is None else 'start' if starting else 'resume', '--sessions-dir', args.sessions_dir]
    if not starting: command += ['--id', args.id]
    if question is not None: command += ['--root', args.root, '--allow=' + args.allow, '--once=' + question]
    if args.events_policy_dir is not None: command += ['--events-policy-dir', args.events_policy_dir]
    if natural: command += ['--natural-work']
    observer = NaturalObserver(['*'] if args.discover else args.allow.split(','))
    code = edit.run_owned(command, dict(os.environ), diagnostic=observer, **({} if tty else {'input_data': b''}))
    return code, observer


def work_command(args, action, root, operation_id, path, task, check):
    command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), action,
               '--sessions-dir', args.sessions_dir, '--id', args.id, '--read-root', args.root,
               '--root', root, '--operation-id=' + operation_id,
               '--path=' + path, '--allow=' + (path if args.discover else args.allow), '--once=' + task, '--interactive-check']
    if args.events_policy_dir is not None:command += ['--events-policy-dir', args.events_policy_dir]
    if check is not None:command += ['--check', *check]
    return command


def show_discovery():
    print('Discovery uses pages of 256 files, up to eight automatic pages, seven directory levels and 512 directories; each directory is limited to 1024 entries and 131072 name bytes. Unsupported paths and file types are excluded; .gitignore is not interpreted.', flush=True)
    print('Each automatic page uses another bounded chat turn: up to 6 calls and 24576 output tokens for new sessions. Page contents may change between turns.', flush=True)
    print('Excluded: .git/.hg/.svn/.bzr, dependency and build directories, .venv/.tox/.cache/.mypy_cache/.pytest_cache, .ssh/.aws/.gnupg/.netrc, and .env files except .env.example/.env.sample.', flush=True)
    print('Dotfiles and project configuration in scope may be sent to the model.', flush=True)
    print('A link outside the selected workspace stops discovery; choose a narrower root.', flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions-dir', required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--id')
    selection.add_argument('--new', action='store_true', help='create a session on the first read turn')
    parser.add_argument('--root', required=True)
    files = parser.add_mutually_exclusive_group(required=True)
    files.add_argument('--allow')
    files.add_argument('--discover', action='store_true')
    parser.add_argument('--page', type=int, default=0, choices=range(8), help='discovery page, 0..7')
    parser.add_argument('--events-policy-dir')
    parser.add_argument('--once', help='run exactly one read-only turn')
    parser.add_argument('--check', nargs=argparse.REMAINDER, help='optional command after each natural-language edit')
    args = parser.parse_args(argv)
    if args.check == []:parser.error('--check requires a command')
    if args.page and not args.discover: parser.error('--page requires --discover')
    if args.discover: args.allow = '*' + str(args.page)
    stdin_tty = sys.stdin.isatty()
    tty = stdin_tty and sys.stdout.isatty()
    if args.once is None and not tty:
        if stdin_tty:
            print('REFUSED redirected output requires --once QUESTION or one piped line', file=sys.stderr)
            return 64
        try:
            args.once = piped_question(sys.stdin)
        except (ValueError, OSError) as error:
            print('REFUSED ' + str(error), file=sys.stderr)
            return 64
        except KeyboardInterrupt:
            print('Input cancelled.', file=sys.stderr)
            return 130
    if args.discover: show_discovery()
    print('A read turn may reserve up to 6 calls and 24576 output tokens for new sessions: up to 4 child calls at 4096 each and 2 parent calls at up to 4096 each; up to 3 read/search operations reserve 4 MiB plus 256 probe bytes each.', flush=True)
    if args.once is not None: print('An unfinished delegated answer may use one additional read turn with the same limits.', flush=True)
    if args.id is not None:
        show_resume(args, show_id=True)
    else:
        print('New session: the first question starts a read turn.', flush=True)
        if args.events_policy_dir is not None:
            print('Event recording supports successive work operations, each with an optional check and fresh approval; each new-session work reserves up to 7 model calls and 61440 output tokens.', flush=True)
        else:
            print('Work requires a completed first turn.', flush=True)
    if tty and args.once is None:
        saved = '/events' if args.events_policy_dir is not None else '/outputs'
        print('Enter a question or an edit request, /help, /status, ' + saved + ', /check, /work, /followup, /scope, /allow FILES, /discover [N], /page N or /exit.', flush=True)
    while True:
        if args.once is not None:
            question = args.once
        else:
            try:
                question = input('nomo> ')
            except EOFError:
                print()
                return 0
            except KeyboardInterrupt:
                print('\nInput cancelled.', file=sys.stderr)
                return 130
            if question == '/exit':
                return 0
            if question == '/scope':
                print('Current scope: ' + ('discovery page ' + str(args.page) if args.discover else args.allow), flush=True)
                continue
            if question == '/allow' or question.startswith('/allow '):
                names = question[6:].strip().split(',')
                if not 1 <= len(names) <= 4 or len(set(names)) != len(names) or any(not edit.safe_path(name) for name in names):
                    print('REFUSED /allow requires one to four distinct safe relative files.', file=sys.stderr, flush=True)
                else:
                    args.discover = False; args.allow = ','.join(names); args.page = 0
                    print('Selected explicit files: ' + args.allow + '. Saved history may still contain previously read data.', flush=True)
                continue
            if question == '/discover' or question.startswith('/discover '):
                choice = question[9:].strip() or '0'
                if choice not in tuple(str(i) for i in range(8)):
                    print('REFUSED /discover requires a page from 0 to 7.', file=sys.stderr, flush=True)
                else:
                    args.discover = True; args.page = int(choice); args.allow = '*' + choice
                    print('Selected discovery page ' + choice + '.', flush=True); show_discovery()
                continue
            if question.startswith('/page '):
                choice = question[6:]
                if not args.discover or choice not in tuple(str(i) for i in range(8)):
                    print('REFUSED /page requires discovery and a page from 0 to 7.', file=sys.stderr, flush=True)
                else:
                    args.page = int(choice); args.allow = '*' + choice
                    print('Selected discovery page ' + choice + '; the next request uses a fresh traversal.', flush=True)
                continue
            if question == '/help':
                print('Read turns use the selected root and allowlist. /scope shows it; /allow FILES selects up to four files; /discover [N] enables bounded discovery. /status inspects recorded state. /check [COMMAND ARG ... | --clear] shows, sets or clears the automatic check; /check --run runs it now; event sessions save filtered output for later model context.')
                print('Natural-language edits target selected files in the current root; each requires preview and fresh confirmation. The root must be owned by you and not writable by group or others.')
                if args.events_policy_dir is not None:print('/events displays committed events grouped by chat, work and followup; /status shows bounded check output.')
                else:print('/outputs shows recorded check output.')
                if args.events_policy_dir is None:
                    print('/work OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs one explicitly confirmed work operation.')
                    print('/followup OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs the second bounded work operation.')
                else:
                    print('/work OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs one confirmed work operation.')
                    print('/followup OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs another confirmed work operation (up to 32 additional rounds).')
                print('Quote arguments containing spaces. Check arguments are passed directly, without implicit shell expansion. /exit leaves the session.')
                continue
            if question in ('/status','/events','/outputs'):
                if args.id is None:
                    print('REFUSED enter a first question to start the session.', file=sys.stderr, flush=True)
                    continue
                if question == '/outputs' and args.events_policy_dir is not None:
                    print('REFUSED /outputs is unavailable in event-recording mode; /status shows bounded recorded check output.',file=sys.stderr,flush=True)
                    continue
                if question == '/events' and args.events_policy_dir is None:
                    print('REFUSED /events requires event-recording mode and its policy.',file=sys.stderr,flush=True)
                    continue
                command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'status',
                           '--sessions-dir', args.sessions_dir, '--id', args.id]
                if question == '/outputs':command += ['--outputs']
                if question == '/events':command += ['--events']
                if args.events_policy_dir is not None:command += ['--events-policy-dir',args.events_policy_dir]
                code = edit.run_owned(command, dict(os.environ))
                if code:
                    print('Status failed; inspect session state before continuing.', file=sys.stderr, flush=True)
                    return code
                continue
            if any(question == '/' + name or question.startswith('/' + name + ' ') for name in ('check','work','followup')):
                try:
                    words = shlex.split(question)
                    action = words[0][1:]
                    if action == 'check':
                        if words[1:] == ['--run']:
                            if not args.check: raise ValueError('configure a check before running it')
                            if args.id is None and args.events_policy_dir is not None:
                                code, observer = chat_turn(args, None, True, False, tty)
                                if code or observer.identifier is None:
                                    show_status_hint(args, observer.identifier); return code or 1
                                args.id = observer.identifier; show_resume(args, show_id=False)
                            if args.id is not None and args.events_policy_dir is not None:
                                state = session_state(args)
                                command = [sys.executable, str(ROOT/'scripts/nomo-history-work.py'), '--independent-check', '--state', str(state), '--root', args.root,
                                           '--id', 'check-' + secrets.token_hex(16), '--events-policy-dir', args.events_policy_dir, '--check', *args.check]
                                code = edit.run_owned(command, dict(os.environ))
                                if code: return code
                            else:
                                print('Running the configured check now; its output is not saved in session history or sent to the model.', flush=True)
                                code = edit.run_owned([sys.executable, str(ROOT/'scripts/nomo-edit.py'), '--check-only', '--root', args.root, '--', *args.check], dict(os.environ))
                                if code == 130: return 130
                            continue
                        if words[1:] == ['--clear']: args.check = None
                        elif len(words) > 1:
                            if not words[1]: raise ValueError('check command must not be empty')
                            args.check = words[1:]
                        print('Automatic check for future natural edits: ' + (shlex.join(args.check) if args.check else 'none'), flush=True)
                        continue
                    if args.id is None: raise ValueError('enter a first question to start the session')
                    if len(words) < 5 or (len(words) > 5 and (words[5] != '--check' or len(words) == 6)):
                        raise ValueError('expected /work or /followup OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...]')
                    command = work_command(args, action, words[2], words[1], words[3], words[4], words[6:] if len(words) > 5 else None)
                except ValueError as error:
                    print('REFUSED ' + str(error), file=sys.stderr, flush=True)
                    continue
                print('Work uses the selected read root, explicit edit root, and new confirmations.', flush=True)
                code = edit.run_owned(command, dict(os.environ))
                if code:
                    print('Work stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
                    show_status_hint(args, args.id)
                    return code
                continue
        if not edit.safe_read_question(question):
            print('REFUSED question requires 1..512 safe UTF-8 bytes and non-empty text.', file=sys.stderr)
            if args.once is not None:
                return 64
            continue
        starting = args.id is None
        natural = tty and args.once is None
        code, observer = chat_turn(args, question, starting, natural, tty)
        if code:
            print('Turn stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
            show_status_hint(args, observer.identifier if starting else args.id)
            return code
        if starting:
            if observer.identifier is None:
                print('Session ID could not be confirmed; inspect retained state before continuing.', file=sys.stderr, flush=True)
                return 1
            args.id = observer.identifier
            show_resume(args, show_id=False)
        extra_read = False
        while (natural and observer.deferred == 'page') or (observer.deferred == 'read' and not extra_read):
            if observer.deferred == 'page':
                args.page += 1; args.allow = '*' + str(args.page)
                print('The agent is inspecting discovery page ' + str(args.page) + ' using another bounded chat turn.', flush=True)
            else:
                extra_read = True
                print('The agent is gathering more evidence using one additional chat turn (up to 6 calls and 24576 output tokens for new sessions).', flush=True)
            code, observer = chat_turn(args, question, False, natural, tty)
            if code:
                print('Additional read stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
                show_status_hint(args, args.id)
                return code
        if observer.deferred is not None:
            print('The agent could not continue discovery or the additional read; no further edit was made. Refine the scope or inspect the session before continuing.', flush=True)
            if args.once is not None: return 1
        if natural and observer.route is not None:
            action, path = observer.route
            operation_id = 'auto-' + secrets.token_hex(8)
            command = work_command(args, action, args.root, operation_id, path, question, args.check)
            print('Selected ' + path + ' for a proposed edit; review the preview and confirm before writing.', flush=True)
            proof_read, proof_write = os.pipe()
            env = dict(os.environ, NOMO_CLEANUP_PROOF_FD=str(proof_write)); signals = []
            try:
                code = edit.run_owned(command, env, signal_state=signals)
            finally:
                os.close(proof_write)
            os.set_blocking(proof_read, False)
            try:
                proof = os.read(proof_read, 64)
                closed = os.read(proof_read, 1) == b''
            except BlockingIOError: proof, closed = b'', False
            finally: os.close(proof_read)
            if code:
                if recovery_ready(code, signals, proof, closed) and args.events_policy_dir is not None and offer_recovery(args, operation_id, action):
                    print('Continue with a new request; a new edit requires fresh confirmations.', flush=True)
                    continue
                print('Work stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
                show_status_hint(args, args.id)
                return code
        if args.once is not None:
            return 0


if __name__ == '__main__':
    raise SystemExit(main())
