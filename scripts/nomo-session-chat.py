#!/usr/bin/env python3
"""A terminal loop over an existing ID-addressed session."""
import argparse
import importlib.util
import os
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('edit_launcher', ROOT / 'scripts/nomo-edit.py')
edit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edit)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions-dir', required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('--allow', required=True)
    parser.add_argument('--once', help='run exactly one read-only turn')
    args = parser.parse_args(argv)
    tty = sys.stdin.isatty() and sys.stdout.isatty()
    if args.once is None and not tty:
        print('REFUSED non-TTY input requires --once QUESTION', file=sys.stderr)
        return 64
    prefix = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'resume',
              '--sessions-dir', args.sessions_dir, '--id', args.id, '--root', args.root,
              '--allow=' + args.allow]
    print('SESSION ID ' + args.id, flush=True)
    print('Read turns and bounded work use this session; each edit requires fresh confirmations.', flush=True)
    print('Resume: nomo-read.sh session-id resume --sessions-dir ' + shlex.quote(args.sessions_dir)
          + ' --id ' + shlex.quote(args.id) + ' --root DIR --allow FILE --once QUESTION', flush=True)
    if tty and args.once is None:
        print('Enter a question, /help, /status, /work, /followup or /exit.', flush=True)
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
                print('/work OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs one explicitly confirmed work operation.')
                print('/followup OP_ID EDIT_ROOT PATH "TASK" [--check COMMAND ARG ...] runs the second bounded work operation.')
                print('Quote arguments containing spaces. No shell interprets the check arguments. /exit leaves the session.')
                continue
            if question == '/status':
                command = [sys.executable, str(ROOT / 'scripts/nomo-session-id.py'), 'status',
                           '--sessions-dir', args.sessions_dir, '--id', args.id]
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
        code = edit.run_owned(prefix + ['--once=' + question], dict(os.environ))
        if code:
            print('Turn stopped; inspect session status before continuing.', file=sys.stderr, flush=True)
            return code
        if args.once is not None:
            return 0


if __name__ == '__main__':
    raise SystemExit(main())
