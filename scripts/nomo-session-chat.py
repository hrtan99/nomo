#!/usr/bin/env python3
"""A terminal loop over an existing ID-addressed session."""
import argparse
import importlib.util
import json
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
PIPE_PAYLOAD_BYTES = edit.REQUEST_BYTES


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
            raise ValueError('piped question exceeds 65536 UTF-8 bytes')
    if data.endswith(b'\n'):
        del data[-1:]
        if data.endswith(b'\r'):
            del data[-1:]
    try:
        question = data.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('piped input must be valid UTF-8') from error
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
        self.work_marker = ''
        self.deferred = None
        self.check = None
        self.check_invalid = False
        self.final = None

    def feed(self, stream, data):
        super().feed(stream, data)
        if stream != 'stdout':return
        self.buffer.extend(data)
        while b'\n' in self.buffer:
            line, _, remainder = self.buffer.partition(b'\n');self.buffer = bytearray(remainder)
            try: decoded = line.decode('utf-8', 'strict').rstrip('\r'); fields = decoded.split(' ', 3)
            except UnicodeDecodeError: continue
            if decoded.startswith('FINAL '): self.final = decoded[6:]
            if decoded.startswith(('NATURAL CHECK ', 'NATURAL CHECK_JSON ')):
                try:
                    command = json.loads(decoded[len('NATURAL CHECK_JSON '):]) if decoded.startswith('NATURAL CHECK_JSON ') else shlex.split(decoded[len('NATURAL CHECK '):])
                    if self.check is not None or not isinstance(command, list) or not 1 <= len(command) <= 64 or not all(isinstance(arg, str) for arg in command) or not command[0] or sum(len(arg.encode('utf-8')) for arg in command) > edit.REQUEST_BYTES or any(not all(c.isprintable() or c in '\r\n\t' for c in arg) for arg in command): raise ValueError('invalid check proposal')
                    self.check = command
                except (ValueError, UnicodeEncodeError): self.check_invalid = True
            if len(fields)==4 and fields[0]=='NATURAL' and fields[1] in ('WORK','WORK_CHECK','WORK_MORE','WORK_MORE_CHECK') and fields[2] in ('work','followup') and (edit.safe_path(fields[3]) and (fields[3] in self.allowed or '*' in self.allowed)):
                self.route = (fields[2], fields[3])
                self.work_marker = fields[1]
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
        show_work_limits()
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
    # Called only by the live owner after confirmed transport cleanup.
    state = session_state(args)
    policy_spec = importlib.util.spec_from_file_location('event_policy', ROOT / 'scripts/nomo-event-policy.py')
    policy = importlib.util.module_from_spec(policy_spec); policy_spec.loader.exec_module(policy)
    policy_dir, _, binding = policy.read_private(args.events_policy_dir)
    fd = os.open(state / '.nomo-session.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        edit.check_history_lock(fd)
        env = {k:v for k,v in os.environ.items() if not k.startswith('ETAS_HOST_') and k not in ('MINIMAX_API_KEY', 'NOMO_QWEN_SERVER_API_KEY')}
        env.update(NOMO_SESSION_STATE=str(state), NOMO_EVENT_POLICY_DIR=str(policy_dir), NOMO_ETAS_VERSION=os.environ.get('NOMO_ETAS_VERSION', '0.13.5'))
        compose = ['docker', 'compose', '--env-file', '/dev/null']
        for name in ('compose.yaml', 'config/etas-' + env['NOMO_ETAS_VERSION'].replace('.', '') + '-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml', 'config/nomo-read-session-compose.yaml', 'config/nomo-event-policy-work-compose.yaml'):
            compose += ['--file', str(ROOT / name)]
        native = ['python3', '-B', '/workspace/scripts/nomo-event-policy.py', 'mount-bootstrap', binding, 'run', '/workspace', '--flow', 'recoverable_work_abandon' if action == 'work' else 'recoverable_followup_abandon', '--profile', 'nomo-read-events-status', '--allow-effects', '--args', binding, operation_id]
        command = [sys.executable, str(ROOT / 'scripts/terminal-transport.py'), *compose, 'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', '--workdir', '/session-state', 'dev', *native]
        return edit.run_owned(command, env)
    finally: os.close(fd)

def run_with_proof(command):
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
    return code, signals, proof, closed

def recovery_ready(code, signals, proof, closed):
    return closed and ((code == 130 and signals == [signal.SIGINT] and proof == b'clean-sigint\n') or (code not in (0, 125, 130) and signals == [0] and proof == b'clean-exit\n'))

def offer_recovery(args, operation_id, action):
    print('The stopped edit or check may have had effects. Inspect the workspace before continuing; saved records and budgets remain.' if action != 'check' else 'The stopped check may have changed the workspace; its outcome may not be recorded. Inspect it before continuing. The command will not be repeated.', flush=True)
    try: answer = edit.terminal_input('Continue this session? [y/N] ' if action == 'check' else 'Abandon this stopped operation and continue this session? [y/N] ').strip().lower()
    except (EOFError, KeyboardInterrupt): return False
    if answer not in ('y', 'yes'): return False
    try: return action == 'check' or abandon_stopped_work(args, operation_id, action) == 0
    except (OSError, ValueError) as error:
        print('Recovery decision was not confirmed: ' + str(error), file=sys.stderr, flush=True)
        return False

def chat_turn(args, question, starting, natural, tty):
    command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'init' if question is None else 'start' if starting else 'resume', '--sessions-dir', args.sessions_dir]
    if question is None: command += ['--workspace-root', args.root]
    if not starting: command += ['--id', args.id]
    if question is not None: command += ['--root', args.root, '--allow=' + args.allow, '--once=' + question]
    if args.events_policy_dir is not None: command += ['--events-policy-dir', args.events_policy_dir]
    if natural: command += ['--natural-work']
    # Initialization persists the selected format before a possible check, so
    # the first later read must not silently lose an explicit high-input mode.
    if starting and getattr(args, 'high_input', False): command += ['--high-input']
    observer = NaturalObserver(['*'] if args.discover else args.allow.split(','))
    code = edit.run_owned(command, dict(os.environ), diagnostic=observer, **({} if tty else {'input_data': b''}))
    return code, observer


def run_recorded_check(args, command, check_id=None):
    state = session_state(args)
    request = [sys.executable, str(ROOT/'scripts/nomo-history-work.py'), '--independent-check', '--state', str(state), '--root', args.root,
               '--id', check_id or 'check-' + secrets.token_hex(16), '--events-policy-dir', args.events_policy_dir, '--check', *command]
    code, signals, proof, closed = run_with_proof(request)
    if recovery_ready(code, signals, proof, closed) and offer_recovery(args, None, 'check'): return None
    return code


def work_command(args, action, root, operation_id, path, task, check):
    command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), action,
               '--sessions-dir', args.sessions_dir, '--id', args.id, '--read-root', args.root,
               '--root', root, '--operation-id=' + operation_id,
               '--path=' + path, '--allow=' + (path if args.discover else args.allow), '--once=' + task, '--interactive-check']
    if args.events_policy_dir is not None:command += ['--events-policy-dir', args.events_policy_dir]
    if check is not None:command += ['--check', *check]
    return command


def show_discovery(mode):
    print('Discovery uses pages of 256 files, up to eight automatic pages, seven directory levels and 512 directories; each directory is limited to 1024 entries and 131072 name bytes. Unsupported paths and file types are excluded; .gitignore is not interpreted.', flush=True)
    if mode == 'high-input':
        print('Each automatic page uses another bounded high-input chat turn: up to 6 calls and 786432 output tokens. Page contents may change between turns.', flush=True)
    elif mode == 'default':
        print('Each automatic page uses another bounded chat turn: up to 6 calls and 405504 output tokens for this new event session. Page contents may change between turns.', flush=True)
    else:
        print('Each automatic page uses another bounded chat turn under this session\'s persisted budget; /status reports its recorded reservation. Page contents may change between turns.', flush=True)
    print('Excluded: .git/.hg/.svn/.bzr, dependency and build directories, .venv/.tox/.cache/.mypy_cache/.pytest_cache, .ssh/.aws/.gnupg/.netrc, and .env files except .env.example/.env.sample.', flush=True)
    print('Dotfiles and project configuration in scope may be sent to the model.', flush=True)
    print('A link outside the selected workspace stops discovery; choose a narrower root.', flush=True)


def show_work_limits():
    print('Event recording supports successive work operations, each with an optional check and fresh approval. Normal work reserves 7 calls, 286720 output tokens and 2811008 configured native tokens; persisted high-input work reserves 7 calls, 917504 output tokens and a 7340032 configured native-token run ledger while retaining recovered conversation. Each high-input call may generate up to 131072 tokens, including reasoning. Both modes allow one read/search up to 1048580 bytes and three edit reads of up to 1048576 bytes each; configured allowances are not measured provider usage.', flush=True)


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
    parser.add_argument('--high-input', action='store_true', help='new event session only: retain history and reserve 131072 output tokens per model call')
    parser.add_argument('--once', help='run exactly one read-only turn')
    parser.add_argument('--check', nargs=argparse.REMAINDER, help='optional command after each natural-language edit')
    args = parser.parse_args(argv)
    if args.high_input and (not args.new or args.events_policy_dir is None): parser.error('--high-input requires --new and --events-policy-dir')
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
    budget_mode = 'high-input' if args.high_input else 'default' if args.new else 'persisted'
    if args.discover: show_discovery(budget_mode)
    if budget_mode == 'high-input':
        print('High-input mode is persisted for this new session. A read turn reserves up to 6 calls and 786432 output tokens, with 131072 for every model call including reasoning; at most 6291456 configured native tokens in total. Provider input and output share its context window; actual input and usage are unknown.', flush=True)
    elif budget_mode == 'default':
        print('A read turn in a new event session may reserve up to 6 calls and 405504 output tokens: up to 3 child action calls at 4096 each, one child final and 2 parent calls at 131072 each; at most 3786432 configured native tokens in total; up to 3 read/search operations reserve 4 MiB plus 256 probe bytes each. Older sessions retain their original allowance.', flush=True)
    else:
        print('This resumed session keeps its persisted model budget. Use /status for the recorded reservation; input and output share the provider context window and actual usage is unknown.', flush=True)
    if args.once is not None: print('An unfinished delegated answer may use one additional read turn with the same limits.', flush=True)
    if args.id is not None:
        show_resume(args, show_id=True)
    else:
        print('New session: the first question starts a read turn.', flush=True)
        if args.events_policy_dir is not None:
            show_work_limits()
        else:
            print('Work requires a completed first turn.', flush=True)
    if tty and args.once is None:
        saved = '/events' if args.events_policy_dir is not None else '/outputs'
        print('Enter a question or an edit request, /help, /status, ' + saved + ', /check, /work, /followup, /scope, /allow FILES, /discover [N], /page N or /exit.', flush=True)
    pending_review = None
    active_request = ''
    review_count = 0
    while True:
        automatic = pending_review is not None
        if automatic:
            question, pending_review = pending_review, None
        elif args.once is not None:
            question = args.once
        else:
            try:
                question = edit.terminal_input('nomo> ')
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
                    print('Selected discovery page ' + choice + '.', flush=True); show_discovery(budget_mode)
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
                print('For an explicitly requested check, review the proposed command and approve it; commands may modify workspace files.')
                if args.events_policy_dir is not None:print('/events displays committed events in the recorded timeline and work of unknown order; /status shows bounded check output.')
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
                                code = run_recorded_check(args, args.check)
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
        if not automatic:
            active_request = question
            review_count = 0
        if not edit.safe_read_question(question):
            print('REFUSED question requires 1..65536 safe UTF-8 bytes and non-empty text.', file=sys.stderr)
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
                print('The agent is gathering more evidence using one additional chat turn (' +
                      ('up to 6 calls and 786432 output tokens in this new high-input session' if args.high_input else
                       'the same persisted limits as this session' if not starting else
                       'up to 6 calls and 405504 output tokens in this new event session') + ').', flush=True)
            code, observer = chat_turn(args, question, False, natural, tty)
            if code:
                print('Additional read stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
                show_status_hint(args, args.id)
                return code
        if observer.deferred is not None:
            print('The agent could not continue discovery or the additional read; no further edit was made. Refine the scope or inspect the session before continuing.', flush=True)
            if args.once is not None: return 1
        edits_left = 3; requested_check = False
        while natural and observer.route is not None and not observer.check_invalid and observer.check is None:
            action, path = observer.route
            operation_id = 'auto-' + secrets.token_hex(8)
            command = work_command(args, action, args.root, operation_id, path, question, args.check)
            print('Selected ' + path + ' for a proposed edit; review the preview and confirm before writing.', flush=True)
            code, signals, proof, closed = run_with_proof(command)
            if code:
                if recovery_ready(code, signals, proof, closed) and args.events_policy_dir is not None and offer_recovery(args, operation_id, action):
                    print('Continue with a new request; a new edit requires fresh confirmations.', flush=True)
                    observer.route = None
                    break
                print('Work stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
                show_status_hint(args, args.id)
                return code
            edits_left -= 1; requested_check = requested_check or observer.work_marker in ('WORK_CHECK', 'WORK_MORE_CHECK')
            if args.check and args.events_policy_dir is not None:
                print('Check recorded. Reviewing its result against the original request.', flush=True)
                pending_review = 'AUTO-CONTINUATION: Review the latest recorded edit and check against this original user request: ' + active_request + ' If the check failed, select the file needing repair with EDIT_CHECK; otherwise report completion or identify an unmet requirement using current evidence. Do not repeat a passed check.'
            if observer.work_marker in ('WORK_MORE', 'WORK_MORE_CHECK'):
                if not edits_left or args.events_policy_dir is None:
                    print('Further requested edits remain; automatic continuation stopped. Review the session and ask for the next file.', flush=True); break
                print('Edit completed. Selecting the next requested file uses another bounded read-only model turn; each edit needs fresh confirmations.', flush=True)
                request = 'AUTO-CONTINUATION: For the most recent non-AUTO-CONTINUATION user request and completed edit ' + operation_id + ', select the next requested existing file, or say if no further edit is established.'
                try: code, observer = chat_turn(args, request, False, True, tty)
                except (OSError, ValueError) as error:
                    print('Completed edits remain recorded; next edit selection could not start: ' + str(error), file=sys.stderr, flush=True); return 1
                if code:
                    print('Completed edits remain recorded; next edit selection stopped.', file=sys.stderr, flush=True); return code
                if observer.deferred or observer.route is None or observer.route[0] != 'followup' or observer.check is not None or observer.check_invalid:
                    print('Further requested edits could not be selected; no further action was run.', flush=True); observer.route = None; observer.check = None; observer.check_invalid = False; break
                continue
            if requested_check and not args.check:
                if args.events_policy_dir is None:
                    print('Edit completed; proposed checks require event recording. Select a command with /check.', flush=True)
                else:
                    print('Edit completed. Finding the requested check uses another bounded read-only model turn.', flush=True)
                    request = 'AUTO-CONTINUATION: For the most recent non-AUTO-CONTINUATION user request and completed edit ' + operation_id + ', propose one suitable CHECK command, or say if evidence is insufficient. Do not propose another edit.'
                    try: code, observer = chat_turn(args, request, False, True, tty)
                    except (OSError, ValueError) as error:
                        print('Edit remains recorded; check proposal could not start: ' + str(error), file=sys.stderr, flush=True); return 1
                    if code:
                        print('Edit remains recorded; check proposal stopped. Inspect the session before continuing.', file=sys.stderr, flush=True); return code
                    if observer.deferred or observer.route or (observer.check is None and not observer.check_invalid):
                        print('Edit completed; no check command was proposed or run.', flush=True); continue
            break
        if natural and (observer.check_invalid or (observer.check is not None and observer.route is not None)):
            print('REFUSED invalid or ambiguous proposed check; no command was run.', file=sys.stderr, flush=True)
            continue
        if natural and observer.check is not None:
            if args.events_policy_dir is None:
                print('REFUSED proposed checks require event recording; use /check to run a selected command.', file=sys.stderr, flush=True)
                continue
            print('Proposed check: ' + shlex.join(observer.check) + '\nRuns offline in the selected workspace and may modify its files. Filtered output is saved and may be sent to the model.', flush=True)
            try: approval = edit.terminal_input('Run this exact command? [y/N] ').strip().lower()
            except EOFError: approval = ''
            except KeyboardInterrupt: print('\nCheck cancelled.', file=sys.stderr, flush=True); return 130
            if approval not in ('y', 'yes'):
                print('Check declined; no command was run.', flush=True)
                continue
            check_id = 'check-' + secrets.token_hex(16)
            try: code = run_recorded_check(args, observer.check, check_id)
            except (OSError, ValueError) as error:
                print('Check or summary could not start or complete; inspect the session: ' + str(error), file=sys.stderr, flush=True); return 1
            if code is None: continue
            if code:
                print('Check stopped or its result was not recorded; inspect the workspace and session before continuing.', file=sys.stderr, flush=True)
                return code
            print('Check recorded. Reviewing its result against the original request.', flush=True)
            pending_review = 'AUTO-CONTINUATION: Review the latest recorded check against this original user request: ' + active_request + ' If it failed, select the file needing repair with EDIT_CHECK; otherwise report completion or identify an unmet requirement using current evidence. Do not repeat a passed check.'
        if pending_review is not None:
            review_count += 1
            if review_count >= 12:
                pending_review = None
                print('Automatic review reached 12 rounds; completed work and checks are saved.', flush=True)
            continue
        if args.once is not None:
            return 0


if __name__ == '__main__':
    from nomo_terminal import install
    install()
    raise SystemExit(main())
