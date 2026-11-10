#!/usr/bin/env python3
"""Project conversations, backed by the Etas model and project tool ports."""
from pathlib import Path
import argparse
import json
import os
import pydoc
import shlex
import subprocess
import sys
from nomo_history import SqliteHistory
from nomo_project import ProjectRegistry, Workspace
from nomo_project_model import NativeModel, RollingContext
from nomo_project_tools import ToolRegistry

ROOT = Path(__file__).resolve().parent.parent

HELP = '''Project: /open [FOLDER], /projects, /new, /sessions [all], /resume [ID]
History: /history [TEXT], /rename TITLE, /fork [EVENT_ID], /export FILE, /import FILE [PROJECT]
Context: /compact, /status
Files:   /tree [PATH] [DEPTH], /glob PATTERN, /read FILE [FIRST LAST], /search TEXT, /regex PATTERN
Process: /exec ARGV..., /spawn ARGV..., /jobs, /poll JOB [OFFSET], /send JOB TEXT, /stop JOB
Edits:   /undo [EDIT_ID]
Git:     /git status|diff [FILES...]|log|branches|init|branch NAME|switch NAME|commit MESSAGE [FILES...]
/help, /exit
Enter a task normally. The agent can create/edit/move/delete files and run tools.
Related file changes share one preview and approval. Full history is always saved;
automatic summaries change only the model context. Background jobs survive exit.'''


class ProjectApplication:
    def __init__(self, state, root, session=None, model=None, approve=None):
        self.state = Path(state)
        self.history = SqliteHistory(state)
        self.projects = ProjectRegistry(state)
        self.model = model or NativeModel()
        self.approval = approve
        self.open(root, session)

    def open(self, root, session=None):
        self.workspace = Workspace(root)
        if session:
            saved = self.history.session(session, root)
            if saved['root'] != str(self.workspace.root):
                raise ValueError('session belongs to ' + saved['root'])
        self.session = session or self.history.create(self.workspace.root)
        self.tools = ToolRegistry(self.workspace, self.state, self.session)
        self.context = RollingContext(self.history, self.session, self.workspace, self.model)
        self.projects.touch(self.workspace.root)
        print(f'[PROJECT] {self.workspace.root}\n[SESSION] {self.session}', flush=True)

    def approve(self, preview):
        if self.approval is not None:
            return self.approval(preview)
        print(preview, flush=True)
        if not sys.stdin.isatty():
            print('[EDIT   ] Approval requires an interactive terminal. Proposal saved.', flush=True)
            return False
        return input('Apply/run this proposal? [y/N] ').strip().lower() in ('y', 'yes')

    def ask(self, request):
        self.history.append(self.session, 'user', request)
        needs_check = False
        while True:
            payload = self.context.current()
            action = self.model.next(payload)
            self.context.record_usage(payload)
            self.history.append(self.session, 'assistant', json.dumps(action, ensure_ascii=False), kind='action', name=action['tool'], data=action)
            if action['tool'] == 'answer':
                if needs_check and self.workspace.config.check:
                    check = empty_action('exec'); check['arguments'] = self.workspace.config.check
                    result = self.tools.execute(check, self.approve)
                    self.history.append(self.session, 'tool', json.dumps(result, ensure_ascii=False), name='configured_check')
                    if isinstance(result, dict) and result.get('status') == 'declined':
                        return None
                    needs_check = False
                    continue
                self.history.append(self.session, 'assistant', action['text'])
                print('\n' + action['text'], flush=True)
                return action['text']
            print('[TOOL   ] ' + action['tool'] + (' ' + action['path'] if action['path'] else ''), flush=True)
            try:
                result = self.tools.execute(action, self.approve)
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                result = {'status': 'error', 'message': str(error)}
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            self.history.append(self.session, 'tool', text, name=action['tool'])
            if isinstance(result, dict) and result.get('status') == 'applied':
                needs_check = True
            if action['tool'] == 'exec':
                needs_check = False
            print(text, flush=True)
            if isinstance(result, dict) and result.get('status') == 'declined':
                print('[SESSION] Proposal declined; enter a new instruction.', flush=True)
                return None

    def resume(self, identifier=None):
        selected = identifier or self.history.choose()
        if selected:
            saved = self.history.session(selected, self.workspace.root)
            self.open(saved['root'], selected)

    def status(self):
        saved = self.history.session(self.session)
        messages = self.history.events(self.session)
        context = self.context.payload(self.history.context(self.session))
        print(json.dumps({'session': self.session, 'title': saved['title'], 'project': str(self.workspace.root),
                          'saved_events': len(messages), 'context_messages': len(context['history']),
                          'estimated_context_tokens': context['estimated_tokens'], 'context_window': context['context_window'],
                          'output_allowance': context['output_allowance'], 'last_measured_usage': json.loads(saved['usage']),
                          'compacted_through_event': saved['compacted_through'], 'jobs': self.tools.tools['jobs'].processes.jobs()},
                         ensure_ascii=False, indent=2))

    def command(self, line):
        parts = shlex.split(line)
        command, arguments = parts[0], parts[1:]
        if command == '/exit':
            return False
        if command == '/help':
            print(HELP)
        elif command == '/open':
            root = arguments[0] if arguments else self.projects.choose()
            self.open(root)
        elif command == '/projects':
            for row in self.projects.recent():
                print(row['name'] + '  ' + row['root'])
        elif command == '/new':
            self.open(self.workspace.root)
        elif command == '/sessions':
            show_sessions(self.history, None if arguments == ['all'] else self.workspace.root)
        elif command == '/resume':
            self.resume(arguments[0] if arguments else None)
        elif command in ('/history', '/events'):
            pydoc.pager(self.history.transcript(self.session, ' '.join(arguments)))
        elif command == '/rename':
            self.history.rename(self.session, ' '.join(arguments))
        elif command == '/fork':
            target = self.history.fork(self.session, int(arguments[0]) if arguments else None)
            self.resume(target)
        elif command == '/export':
            print(self.history.export(self.session, arguments[0]))
        elif command == '/import':
            self.resume(self.history.import_file(arguments[0], arguments[1] if len(arguments) > 1 else None))
        elif command == '/compact':
            self.context.compact(force=True)
        elif command == '/status':
            self.status()
        elif command == '/git':
            operation = arguments[0]
            tool = {'status': 'git_status', 'diff': 'git_diff', 'log': 'git_log', 'branches': 'git_branches',
                    'init': 'git_init', 'branch': 'git_branch', 'switch': 'git_switch', 'commit': 'git_commit'}[operation]
            action = empty_action(tool)
            if operation in ('branch', 'switch'):
                action['target'] = arguments[1]
            elif operation == 'commit':
                action['text'] = arguments[1]; action['arguments'] = arguments[2:]
            elif operation == 'diff':
                action['arguments'] = arguments[1:]
            result = self.tools.execute(action, lambda preview: True)
            self.history.append(self.session, 'user', line, kind='command')
            self.history.append(self.session, 'tool', json.dumps(result, ensure_ascii=False), name=tool)
            print(result['output'])
        elif command == '/tree':
            print(self.workspace.tree(arguments[0] if arguments else '.', int(arguments[1]) if len(arguments) > 1 else 3))
        elif command == '/glob':
            print(self.workspace.glob(arguments[0]))
        elif command == '/read':
            print(self.workspace.read(arguments[0], int(arguments[1]) if len(arguments) > 1 else 1, int(arguments[2]) if len(arguments) > 2 else 0))
        elif command in ('/search', '/regex'):
            print(self.workspace.search(' '.join(arguments), regex=command == '/regex'))
        elif command in ('/exec', '/spawn', '/poll', '/send', '/stop', '/jobs', '/undo'):
            tool = {'/send': 'write_stdin'}.get(command, command[1:])
            action = empty_action(tool)
            if tool in ('exec', 'spawn'):
                action['arguments'] = arguments
            elif arguments:
                action['target'] = arguments[0]
            if tool == 'poll' and len(arguments) > 1:
                action['start'] = int(arguments[1])
            if tool == 'write_stdin':
                action['text'] = ' '.join(arguments[1:]) + '\n'
            # An explicit user command authorizes that exact operation.
            result = self.tools.execute(action, lambda preview: True)
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
            self.history.append(self.session, 'user', line, kind='command')
            self.history.append(self.session, 'tool', text, name=tool)
            print(text)
        else:
            raise ValueError('unknown command; use /help')
        return True

    def close(self):
        self.model.close()


def empty_action(tool):
    return {'tool': tool, 'path': '', 'target': '', 'text': '', 'arguments': [], 'changes': [], 'start': '', 'end': ''}


def show_sessions(history, root=None):
    from datetime import datetime
    for index, row in enumerate(history.sessions(root), 1):
        stamp = datetime.fromtimestamp(row['updated']).strftime('%Y-%m-%d %H:%M')
        print(f'{index:>3}  {stamp}  {row["title"]}\n     {row["id"]}  {row["root"]}\n     {row["preview"]}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root')
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--id')
    selection.add_argument('--latest', action='store_true')
    selection.add_argument('--resume', nargs='?', const='')
    parser.add_argument('--open', nargs='?', const='')
    parser.add_argument('--projects', action='store_true')
    parser.add_argument('--sessions', action='store_true')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--history', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--events', action='store_true')
    parser.add_argument('--export', dest='export_file')
    parser.add_argument('--import', dest='import_file')
    parser.add_argument('--title')
    parser.add_argument('--once')
    parser.add_argument('--high-input', action='store_true', help='project mode always enables full output and automatic context compaction')
    parser.add_argument('--allow', help='legacy option: project mode grants tools the selected project root')
    parser.add_argument('--page', type=int, help='legacy option: project tools navigate on demand')
    parser.add_argument('--check', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    state = Path(os.environ.get('NOMO_STATE_DIR') or Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state') / 'nomo').expanduser().resolve()
    history, projects = SqliteHistory(state), ProjectRegistry(state)
    if args.projects:
        for row in projects.recent():
            print(row['name'] + '  ' + row['root'])
        return 0
    root = args.open or args.root or os.getcwd()
    if args.open == '':
        root = projects.choose()
    root = str(Path(root).expanduser().resolve())
    if args.sessions:
        show_sessions(history, None if args.all else root); return 0
    identifier = args.id
    if args.import_file:
        identifier = history.import_file(args.import_file, root=args.root)
    if args.latest:
        rows = history.sessions(root)
        if not rows:
            raise ValueError('no saved session for this project')
        identifier = rows[0]['id']
    if args.resume is not None:
        identifier = args.resume or history.choose(None if args.all else root)
        if not identifier:
            return 0
    if identifier:
        root = history.session(identifier, root)['root']
    app = ProjectApplication(state, root, identifier)
    try:
        if args.title:
            history.rename(app.session, args.title)
        if args.check:
            app.workspace.config.check = args.check
        if args.status:
            app.status(); return 0
        if args.history or args.events:
            pydoc.pager(history.transcript(app.session)); return 0
        if args.export_file:
            print(history.export(app.session, args.export_file)); return 0
        if args.once:
            return 0 if app.ask(args.once) is not None else 2
        print('Enter a task, /open, /resume, /history or /help. Ctrl-D exits; conversation and jobs remain saved.')
        while True:
            try:
                line = input('nomo> ').strip()
                if not line:
                    continue
                if line.startswith('/'):
                    if not app.command(line):
                        break
                else:
                    app.ask(line)
            except EOFError:
                print(); break
            except KeyboardInterrupt:
                print('\n[SESSION] Interrupted. History saved; background jobs remain available.'); break
            except (OSError, ValueError, IndexError, RuntimeError) as error:
                print('[ERROR  ] ' + str(error), file=sys.stderr)
        return 0
    finally:
        app.close()


if __name__ == '__main__':
    raise SystemExit(main())
