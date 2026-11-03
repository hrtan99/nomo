#!/usr/bin/env python3
"""A terminal loop over an existing ID-addressed session."""
import argparse
import importlib.util
import os
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

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions-dir', required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('--allow', required=True)
    parser.add_argument('--once', help='run exactly one read-only turn')
    args = parser.parse_args(argv)
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
    prefix = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'resume',
              '--sessions-dir', args.sessions_dir, '--id', args.id, '--root', args.root,
              '--allow=' + args.allow]
    print('SESSION ID ' + args.id, flush=True)
    print('Read turns and bounded work use this session; each edit requires fresh confirmations.', flush=True)
    print('Resume: nomo-read.sh session-id resume --sessions-dir ' + shlex.quote(args.sessions_dir)
          + ' --id ' + shlex.quote(args.id) + ' --root DIR --allow FILE --once QUESTION', flush=True)
    if tty and args.once is None:
        print('Enter a question, /help, /status, /outputs, /work, /followup or /exit.', flush=True)
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
                print('Read turns use the selected root and allowlist. /status inspects recorded state; /outputs shows recorded check output.')
                print('/work OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs one explicitly confirmed work operation.')
                print('/followup OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs the second bounded work operation.')
                print('Quote arguments containing spaces. No shell interprets the check arguments. /exit leaves the session.')
                continue
            if question == '/status' or question == '/outputs':
                command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'status',
                           '--sessions-dir', args.sessions_dir, '--id', args.id]
                if question == '/outputs':command += ['--outputs']
                code = edit.run_owned(command, dict(os.environ))
                if code:
                    print('Status failed; inspect session state before continuing.', file=sys.stderr, flush=True)
                    return code
                continue
            if question == '/work' or question.startswith('/work ') or question == '/followup' or question.startswith('/followup '):
                try:
                    words = shlex.split(question)
                    action = words[0][1:]
                    if len(words) < 5 or (len(words) > 5 and (words[5] != '--check' or len(words) == 6)):
                        raise ValueError('expected /work or /followup OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...]')
                    command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), action,
                               '--sessions-dir', args.sessions_dir, '--id', args.id,
                               '--read-root', args.root, '--root', words[2], '--operation-id=' + words[1],
                               '--path=' + words[3], '--allow=' + args.allow, '--once=' + words[4], *words[5:]]
                except ValueError as error:
                    print('REFUSED ' + str(error), file=sys.stderr, flush=True)
                    continue
                print('Work uses the selected read root, explicit edit root, and new confirmations.', flush=True)
                code = edit.run_owned(command, dict(os.environ))
                if code:
                    print('Work stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
                    return code
                continue
        if not question.strip():
            print('Enter a non-empty question.', file=sys.stderr)
            if args.once is not None:
                return 64
            continue
        command = prefix + ['--once=' + question]
        # Non-TTY children get immediate EOF, never extra piped lines.
        code = edit.run_owned(command, dict(os.environ)) if tty else edit.run_owned(command, dict(os.environ), input_data=b'')
        if code:
            print('Turn stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
            return code
        if args.once is not None:
            return 0


if __name__ == '__main__':
    raise SystemExit(main())
