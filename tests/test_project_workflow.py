"""Positive project workflows without a paid model request."""
from pathlib import Path
import json
import sys
import subprocess
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from nomo_history import SqliteHistory
from nomo_jobs import ProcessService
from nomo_project import Workspace
from nomo_project_chat import ProjectApplication, empty_action
from nomo_project_tools import BatchEditor


class ProjectWorkflow(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nomo-project-test-')
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / 'project'
        self.root.mkdir()
        self.state = self.base / 'state'

    def tearDown(self):
        self.temporary.cleanup()

    def test_project_navigation_and_rules(self):
        (self.root / '.gitignore').write_text('cache/\n*.tmp\n!important.tmp\n')
        (self.root / '.nomo.toml').write_text('[project]\ncommand_timeout=120\nignore=["generated/**"]\ninstructions=["Use two spaces"]\n')
        (self.root / 'AGENTS.md').write_text('Keep functions small.')
        (self.root / 'cache').mkdir(); (self.root / 'cache' / 'skip.py').write_text('skip')
        (self.root / 'src').mkdir(); (self.root / 'src' / 'app.py').write_text('VALUE = 42\nprint(VALUE)\n')
        (self.root / 'skip.tmp').write_text('skip'); (self.root / 'important.tmp').write_text('keep')
        workspace = Workspace(self.root)
        self.assertIn('src/app.py', workspace.glob('**/*.py'))
        self.assertNotIn('cache', workspace.tree())
        self.assertNotIn('skip.tmp', workspace.glob())
        self.assertIn('important.tmp', workspace.glob())
        self.assertEqual(workspace.read('src/app.py', 2, 2), '2: print(VALUE)\n')
        self.assertIn('src/app.py:1:VALUE = 42', workspace.search(r'VALUE\s*=\s*\d+', regex=True))
        self.assertEqual(len(workspace.instructions()), 2)

    def test_multi_file_batch_move_and_undo(self):
        editor = BatchEditor(Workspace(self.root), self.state, 'conversation')
        changes = [{'operation': 'create', 'path': 'web/index.html', 'target': '', 'text': '<h1>Hello</h1>\n'},
                   {'operation': 'create', 'path': 'web/style.css', 'target': '', 'text': 'h1 { color: blue; }\n'},
                   {'operation': 'move', 'path': 'web', 'target': 'site', 'text': ''}]
        steps = editor.prepare(changes)
        self.assertIn('web/index.html', editor.preview(steps))
        first = editor.apply(steps)
        move = editor.apply(editor.prepare([{'operation': 'move', 'path': 'site/style.css', 'target': 'site/main.css', 'text': ''}]))
        self.assertTrue((self.root / 'site/main.css').is_file())
        editor.undo(move['edit'])
        self.assertTrue((self.root / 'site/style.css').is_file())
        editor.undo(first['edit'])
        self.assertFalse((self.root / 'web').exists())
        self.assertFalse((self.root / 'site').exists())

    def test_background_interactive_process_survives_client(self):
        processes = ProcessService(self.state, self.root)
        started = processes.start([sys.executable, '-u', '-c', 'print("READY",flush=True); print("VALUE="+input(),flush=True)'])
        identifier = started['job']
        processes = ProcessService(self.state, self.root)
        processes.send(identifier, 'hello\n')
        result = processes.poll(identifier)
        deadline = time.monotonic() + 10
        while result['status'] == 'running' and time.monotonic() < deadline:
            time.sleep(.05); result = processes.poll(identifier)
        self.assertEqual(result['exit_code'], 0)
        self.assertIn('VALUE=hello', result['output'])
        self.assertEqual(processes.poll(identifier, result['offset'])['output'], '')

    def test_full_history_fork_export_import_and_restore(self):
        history = SqliteHistory(self.state)
        session = history.create(self.root)
        first = history.append(session, 'user', 'Create a blue page')
        history.append(session, 'assistant', 'Done')
        history.compact(session, first, 'The user requested a blue page.')
        archive = self.base / 'conversation.json'
        history.export(session, archive)
        imported = history.import_file(archive)
        branch = history.fork(session, first)
        restored = SqliteHistory(self.state)
        self.assertIn('Create a blue page', restored.transcript(session))
        self.assertIn('blue page', restored.context(session)[0]['content'])
        self.assertEqual(len(restored.events(branch)), 1)
        self.assertEqual(len(restored.events(imported)), len(restored.events(session)))
        self.assertEqual(restored.sessions(self.root)[0]['root'], str(self.root))

    def test_agent_creates_files_checks_then_answers(self):
        create = empty_action('batch')
        create['changes'] = [{'operation': 'create', 'path': 'index.html', 'target': '', 'text': '<h1>Pelican</h1>\n'},
                             {'operation': 'create', 'path': 'README.md', 'target': '', 'text': 'Open index.html\n'}]
        check = empty_action('exec')
        check['arguments'] = [sys.executable, '-c', 'from pathlib import Path; assert "Pelican" in Path("index.html").read_text(); print("PASS")']
        final = empty_action('answer'); final['text'] = 'Created both files; check passed.'

        class Model:
            usage = {}
            def __init__(self): self.actions = iter([create, check, final])
            def next(self, context): return next(self.actions)
            def summarize(self, context): return 'Created index.html and README.md; check passed.'
            def close(self): pass

        app = ProjectApplication(self.state, self.root, model=Model(), approve=lambda preview: True)
        self.assertIn('check passed', app.ask('Create the page and README, then verify'))
        app.workspace.config.compact_ratio = .001
        app.context.current()
        self.assertEqual((self.root / 'index.html').read_text(), '<h1>Pelican</h1>\n')
        transcript = app.history.transcript(app.session)
        self.assertIn('Create the page', transcript)
        self.assertIn('PASS', transcript)
        self.assertIn('Created both files', transcript)
        command_result = next(event for event in app.history.events(app.session) if event['role'] == 'tool' and event['name'] == 'exec')
        self.assertEqual(json.loads(command_result['content'])['exit_code'], 0)
        self.assertTrue(app.history.session(app.session)['summary'])

    def test_git_status_diff_branch_and_commit(self):
        from nomo_project_tools import ToolRegistry
        tools = ToolRegistry(Workspace(self.root), self.state, 'git-conversation')
        def run(tool, **fields):
            action = empty_action(tool); action.update(fields)
            return tools.execute(action, lambda preview: True)
        self.assertEqual(run('git_init')['exit_code'], 0)
        subprocess.run(['git', 'config', 'user.name', 'Nomo synthetic test'], cwd=self.root, check=True)
        subprocess.run(['git', 'config', 'user.email', 'nomo-test@example.invalid'], cwd=self.root, check=True)
        (self.root / 'note.txt').write_text('before\n')
        self.assertIn('note.txt', run('git_status')['output'])
        self.assertEqual(run('git_commit', text='Create synthetic note', arguments=['note.txt'])['exit_code'], 0)
        self.assertEqual(run('git_branch', target='feature')['exit_code'], 0)
        self.assertEqual(run('git_switch', target='feature')['exit_code'], 0)
        (self.root / 'note.txt').write_text('after\n')
        self.assertIn('+after', run('git_diff')['output'])
        self.assertIn('Create synthetic note', run('git_log')['output'])

    def test_project_switch_and_history_commands(self):
        class Model:
            usage = {}
            def close(self): pass
        other = self.base / 'other project'; other.mkdir()
        app = ProjectApplication(self.state, self.root, model=Model())
        first = app.session
        event = app.history.append(first, 'user', 'Keep the original request')
        app.command('/rename First project')
        app.command('/open ' + json.dumps(str(other)))
        self.assertEqual(app.workspace.root, other)
        app.command('/resume ' + first)
        self.assertEqual(app.workspace.root, self.root)
        app.command('/fork ' + str(event))
        self.assertNotEqual(app.session, first)
        archive = self.base / 'history.json'
        app.command('/export ' + str(archive))
        app.command('/import ' + str(archive) + ' ' + json.dumps(str(other)))
        self.assertEqual(app.workspace.root, other)
        self.assertIn('Keep the original request', app.history.transcript(app.session))
        self.assertEqual(app.history.choose(other, prompt=lambda _: '1'), app.session)
        self.assertEqual(app.projects.choose(prompt=lambda _: '1'), str(other))


if __name__ == '__main__':
    unittest.main()
