#!/usr/bin/env python3
"""A terminal loop over an existing ID-addressed session."""
import argparse
import importlib.util
import os
import re
import secrets
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
PIPE_PAYLOAD_BYTES = 128


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
            raise ValueError('piped question exceeds 128 UTF-8 bytes')
    if data.endswith(b'\n'):
        del data[-1:]
        if data.endswith(b'\r'):
            del data[-1:]
    if len(data) > PIPE_PAYLOAD_BYTES:
        raise ValueError('piped question exceeds 128 UTF-8 bytes')
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

    def feed(self, stream, data):
        super().feed(stream, data)
        if stream != 'stdout':return
        self.buffer.extend(data)
        while b'\n' in self.buffer:
            line, _, remainder = self.buffer.partition(b'\n');self.buffer = bytearray(remainder)
            fields = line.decode('utf-8', 'replace').rstrip('\r').split(' ')
            if len(fields)==4 and fields[:2]==['NATURAL','WORK'] and fields[2] in ('work','followup') and fields[3] in self.allowed:
                self.route = (fields[2], fields[3])


def show_resume(args, *, show_id):
    if show_id:
        print('SESSION ID ' + args.id, flush=True)
    if args.events_policy_dir is None:
        print('Read turns and bounded work use this session; each edit requires fresh confirmations.', flush=True)
    else:
        print('Event recording supports successive work operations, each with an optional check and fresh approval.', flush=True)
    policy = '' if args.events_policy_dir is None else ' --events-policy-dir ' + shlex.quote(args.events_policy_dir)
    print('Resume: nomo-read.sh session-id resume --sessions-dir ' + shlex.quote(args.sessions_dir)
          + ' --id ' + shlex.quote(args.id) + ' --root DIR --allow FILE' + policy + ' --once QUESTION', flush=True)
    interactive = [str(ROOT / 'scripts/nomo-read.sh'), 'session-chat', '--sessions-dir=' + args.sessions_dir,
                   '--id=' + args.id, '--root=' + args.root, '--allow=' + args.allow]
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

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions-dir', required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--id')
    selection.add_argument('--new', action='store_true', help='create a session on the first read turn')
    parser.add_argument('--root', required=True)
    parser.add_argument('--allow', required=True)
    parser.add_argument('--events-policy-dir')
    parser.add_argument('--once', help='run exactly one read-only turn')
    parser.add_argument('--check', nargs=argparse.REMAINDER, help='optional command after each natural-language edit')
    args = parser.parse_args(argv)
    if args.check == []:parser.error('--check requires a command')
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
    if args.id is not None:
        show_resume(args, show_id=True)
    else:
        print('New session: the first question starts a read turn.', flush=True)
        if args.events_policy_dir is not None:
            print('Event recording supports successive work operations, each with an optional check and fresh approval.', flush=True)
        else:
            print('Work requires a completed first turn.', flush=True)
    if tty and args.once is None:
        saved = '/events' if args.events_policy_dir is not None else '/outputs'
        print('Enter a question or an edit request, /help, /status, ' + saved + ', /work, /followup or /exit.', flush=True)
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
            if question == '/help':
                print('Read turns use the selected root and allowlist. /status inspects recorded state.')
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
            if question == '/work' or question.startswith('/work ') or question == '/followup' or question.startswith('/followup '):
                if args.id is None:
                    print('REFUSED enter a first question to start the session.', file=sys.stderr, flush=True)
                    continue
                try:
                    words = shlex.split(question)
                    action = words[0][1:]
                    if len(words) < 5 or (len(words) > 5 and (words[5] != '--check' or len(words) == 6)):
                        raise ValueError('expected /work or /followup OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...]')
                    command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), action,
                               '--sessions-dir', args.sessions_dir, '--id', args.id,
                               '--read-root', args.root, '--root', words[2], '--operation-id=' + words[1],
                               '--path=' + words[3], '--allow=' + args.allow, '--once=' + words[4]]
                    if args.events_policy_dir is not None:command += ['--events-policy-dir',args.events_policy_dir]
                    command += ['--interactive-check', *words[5:]]
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
        if not question.strip():
            print('Enter a non-empty question.', file=sys.stderr)
            if args.once is not None:
                return 64
            continue
        starting = args.id is None
        command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'start' if starting else 'resume',
                   '--sessions-dir', args.sessions_dir]
        if not starting:
            command += ['--id', args.id]
        command += ['--root', args.root, '--allow=' + args.allow, '--once=' + question]
        if args.events_policy_dir is not None:
            command += ['--events-policy-dir', args.events_policy_dir]
        natural = tty and args.once is None
        if natural:command += ['--natural-work']
        options = {} if tty else {'input_data': b''}
        observer = NaturalObserver(args.allow.split(',')) if natural else (StartIdObserver() if starting else None)
        if observer is not None:
            options['diagnostic'] = observer
        code = edit.run_owned(command, dict(os.environ), **options)
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
        if natural and observer.route is not None:
            action, path = observer.route
            command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), action,
                       '--sessions-dir', args.sessions_dir, '--id', args.id, '--read-root', args.root,
                       '--root', args.root, '--operation-id=auto-' + secrets.token_hex(8),
                       '--path=' + path, '--allow=' + args.allow, '--once=' + question]
            if args.events_policy_dir is not None:command += ['--events-policy-dir', args.events_policy_dir]
            command += ['--interactive-check']
            if args.check is not None:command += ['--check', *args.check]
            print('Selected ' + path + ' for a proposed edit; review the preview and confirm before writing.', flush=True)
            code = edit.run_owned(command, dict(os.environ))
            if code:
                print('Work stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
                show_status_hint(args, args.id)
                return code
        if args.once is not None:
            return 0


if __name__ == '__main__':
    raise SystemExit(main())
