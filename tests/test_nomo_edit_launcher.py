"""Launcher guards for the existing private-workspace edit flow."""
import importlib.util
import io
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('nomo_edit', ROOT / 'scripts/nomo-edit.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class EditLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.project = base / 'project'
        self.workspace = base / 'workspace'
        self.state = base / 'state'
        for path in (self.project, self.workspace, self.state):
            path.mkdir(mode=0o700)
        (self.workspace / 'a.txt').write_text('old')
        self.args = SimpleNamespace(root=str(self.workspace), state=str(self.state), id='case', path='a.txt', target='old', replacement='new', check=None)
        self.root_patch = patch.object(module, 'ROOT', self.project)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def test_private_tty_launches_verified_existing_edit_flow(self):
        with patch.dict(os.environ, {'ETAS_HOST_POLICY': 'unsafe', 'NOMO_KEPT': 'value'}):
            command, check, env = module.prepare(self.args, True, True)
        self.assertIsNone(check)
        self.assertNotIn('ETAS_HOST_POLICY', env)
        self.assertEqual(env['NOMO_KEPT'], 'value')
        self.assertEqual(env['NOMO_EDIT_WORKSPACE_DIR'], str(self.workspace.resolve()))
        self.assertEqual(env['NOMO_EDIT_STATE_DIR'], str(self.state.resolve()))
        self.assertIn('/workspace/scripts/nomo-verified-etas.py', command)
        self.assertEqual(command[command.index('--flow') + 1], 'edit_apply')
        self.assertEqual(command[command.index('--target') + 1], 'old')
        self.assertEqual(command[command.index('--replacement') + 1], 'new')

    def test_requested_check_is_bounded_and_runs_in_selected_workspace(self):
        self.args.check = ['python3', '-m', 'unittest']
        _, check, _ = module.prepare(self.args, True, True)
        self.assertIn(str(self.project / 'config/nomo-check-compose.yaml'), check)
        self.assertIn('--tty=false', check)
        self.assertEqual(check[check.index('--workdir') + 1], '/edit-fixture')
        self.assertEqual(check[-4:], ['60s', 'python3', '-m', 'unittest'])

    def test_explicit_023_applies_to_edit_and_check(self):
        self.args.check = ['true']
        with patch.dict(os.environ, {'NOMO_ETAS_VERSION': '0.2.3'}):
            command, check, _ = module.prepare(self.args, True, True)
        overlay = str(self.project / 'config/etas-023-official-compose.yaml')
        self.assertIn(overlay, command); self.assertIn(overlay, check)
        with patch.dict(os.environ, {'NOMO_ETAS_VERSION': 'unsupported'}), self.assertRaisesRegex(ValueError, 'NOMO_ETAS_VERSION'):
            module.prepare(self.args, True, True)

    def test_explicit_024_applies_to_edit_and_check(self):
        self.args.check = ['true']
        with patch.dict(os.environ, {'NOMO_ETAS_VERSION': '0.2.4'}):
            command, check, _ = module.prepare(self.args, True, True)
        overlay = str(self.project / 'config/etas-024-official-compose.yaml')
        self.assertIn(overlay, command); self.assertIn(overlay, check)

    def test_model_edit_uses_explicit_endpoint_and_keeps_check_offline(self):
        self.args.task = 'change old to new'
        self.args.target = self.args.replacement = None
        self.args.check = ['true']
        with patch.dict(os.environ, {'NOMO_READ_MODEL_BASE_URL': 'http://example.test/v1',
                                    'NOMO_QWEN_SERVER_API_KEY': 'synthetic'}, clear=True):
            command, check, _ = module.prepare(self.args, True, True)
        overlay = str(self.project / 'config/nomo-model-edit-compose.yaml')
        self.assertIn(overlay, command)
        self.assertNotIn(overlay, check)
        self.assertIn(str(self.project / 'config/nomo-edit-compose.yaml'), check)
        self.assertEqual(command[command.index('--flow') + 1], 'harness_edit')
        self.assertEqual(command[command.index('--once') + 1], self.args.task)
        self.assertNotIn('--target', command)

    def test_model_settings_are_not_inherited_by_post_edit_check(self):
        values = {'NOMO_READ_MODEL_BASE_URL': 'http://example.test/v1',
                  'NOMO_QWEN_SERVER_API_KEY': 'synthetic', 'NOMO_READ_MODEL_NAME': 'synthetic-model',
                  'NOMO_KEPT': 'kept'}
        argv = ['--root', str(self.workspace), '--state', str(self.state), '--id', 'case',
                '--path', 'a.txt', '--once', 'change old to new', '--check', 'true']
        calls = []
        with patch.dict(os.environ, values, clear=True), patch.object(module.sys.stdin, 'isatty', return_value=True), \
             patch.object(module.sys.stdout, 'isatty', return_value=True), \
             patch.object(module, 'run_owned', side_effect=lambda command, env: calls.append((command, env)) or 0):
            self.assertEqual(module.main(argv), 0)
        self.assertEqual(len(calls), 2)
        for key in ('NOMO_READ_MODEL_BASE_URL', 'NOMO_QWEN_SERVER_API_KEY', 'NOMO_READ_MODEL_NAME'):
            self.assertEqual(calls[0][1][key], values[key])
            self.assertNotIn(key, calls[1][1])
        self.assertEqual(calls[1][1]['NOMO_KEPT'], 'kept')

    def test_failed_model_edit_reports_unknown_without_starting_check(self):
        argv = ['--root', '/workspace', '--state', '/state', '--id', 'case', '--path', 'a.txt',
                '--once', 'change old to new', '--check', 'true']
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(module, 'prepare', return_value=(['edit'], ['check'], {})), \
             patch.object(module, 'run_owned', return_value=3) as run, \
             redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(module.main(argv), 3)
        self.assertEqual(run.call_count, 1)
        self.assertIn('120-second deadline each; no automatic retries', stdout.getvalue())
        self.assertIn('launcher did not classify the cause', stderr.getvalue())
        self.assertIn('remote outcome may be unknown', stderr.getvalue())
        self.assertIn('Inspect the file and edit status', stderr.getvalue())

    def test_reported_deadline_matches_model_edit_profile(self):
        profile = tomllib.loads((ROOT / 'etas.toml').read_text())['runtime']['profiles']['harness-edit']['model']
        self.assertEqual(profile['timeout']['request_deadline_ms'], 120000)
        self.assertEqual(profile['retry']['attempts'], 1)

    def test_model_edit_requires_explicit_endpoint_and_exclusive_arguments(self):
        self.args.task = 'task'
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, 'either'):
            module.prepare(self.args, True, True)
        self.args.target = self.args.replacement = None
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, 'NOMO_READ_MODEL_BASE_URL'):
            module.prepare(self.args, True, True)
        self.assertFalse((self.project / '.etas').exists())

    def test_noninteractive_refused_before_creating_cache(self):
        with self.assertRaisesRegex(ValueError, 'interactive terminal'):
            module.prepare(self.args, False, False)
        self.assertFalse((self.project / '.etas').exists())

    def test_state_cannot_overlap_or_contain_prior_records(self):
        self.args.state = str(self.workspace)
        with self.assertRaisesRegex(ValueError, 'non-overlapping'):
            module.prepare(self.args, True, True)
        self.args.state = str(self.state)
        (self.state / 'edit.sqlite3').write_text('existing')
        with self.assertRaisesRegex(ValueError, 'empty directory'):
            module.prepare(self.args, True, True)

    def test_reject_symlink_and_parent_escape(self):
        (self.workspace / 'link').symlink_to(self.workspace / 'a.txt')
        self.args.path = 'link'
        with self.assertRaisesRegex(ValueError, 'must not contain symlinks'):
            module.prepare(self.args, True, True)
        self.args.path = '../outside'
        with self.assertRaisesRegex(ValueError, 'relative path inside'):
            module.prepare(self.args, True, True)

    def test_reject_shared_workspace_and_symlink_state(self):
        self.workspace.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'inaccessible'):
            module.prepare(self.args, True, True)
        self.workspace.chmod(0o700)
        link = self.workspace.parent / 'state-link'
        link.symlink_to(self.state, target_is_directory=True)
        self.args.state = str(link)
        with self.assertRaisesRegex(ValueError, 'non-symlink'):
            module.prepare(self.args, True, True)

if __name__ == '__main__':
    unittest.main()
