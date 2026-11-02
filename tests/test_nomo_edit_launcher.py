"""Launcher guards for the existing private-workspace edit flow."""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
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
        self.args = SimpleNamespace(root=str(self.workspace), state=str(self.state), id='case', path='a.txt', target='old', replacement='new')
        self.root_patch = patch.object(module, 'ROOT', self.project)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def test_private_tty_launches_verified_existing_edit_flow(self):
        with patch.dict(os.environ, {'ETAS_HOST_POLICY': 'unsafe', 'NOMO_KEPT': 'value'}):
            command, env = module.prepare(self.args, True, True)
        self.assertNotIn('ETAS_HOST_POLICY', env)
        self.assertEqual(env['NOMO_KEPT'], 'value')
        self.assertEqual(env['NOMO_EDIT_WORKSPACE_DIR'], str(self.workspace.resolve()))
        self.assertEqual(env['NOMO_EDIT_STATE_DIR'], str(self.state.resolve()))
        self.assertIn('/workspace/scripts/nomo-verified-etas.py', command)
        self.assertEqual(command[command.index('--flow') + 1], 'edit_apply')
        self.assertEqual(command[command.index('--target') + 1], 'old')
        self.assertEqual(command[command.index('--replacement') + 1], 'new')

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
