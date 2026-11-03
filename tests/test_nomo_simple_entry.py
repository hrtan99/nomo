import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
loader = importlib.machinery.SourceFileLoader('nomo_simple', str(ROOT/'scripts/nomo'))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class SimpleEntryTests(unittest.TestCase):
    def test_initialize_then_resume_preserves_policy_and_uses_current_root(self):
        with tempfile.TemporaryDirectory(prefix='nomo-entry-') as tmp:
            base = Path(tmp).resolve(); workspace = base/'workspace'; workspace.mkdir()
            state = base/'state'
            with patch.dict(os.environ, {'NOMO_STATE_DIR': str(state)}), \
                 patch.object(module.sys, 'argv', ['nomo', '--root', str(workspace)]), \
                 patch.object(module.os, 'execv') as execute:
                module.main()
                command = execute.call_args.args[1]
                self.assertIn('--new', command)
                self.assertIn('--discover', command)
                self.assertEqual(command[command.index('--root')+1], str(workspace))
                self.assertEqual((state/'sessions').stat().st_mode & 0o777, 0o700)
                policy = state/'policy'; key = (policy/'binding.key').read_bytes()
                self.assertEqual(len(key), 32)
                self.assertEqual((policy/'policy.json').stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads((policy/'policy.json').read_bytes())['format'], 1)
                module.sys.argv = ['nomo', '--root', str(workspace), '--id', 'a'*32]
                module.main()
                self.assertIn('--id='+'a'*32, execute.call_args.args[1])
                self.assertEqual((policy/'binding.key').read_bytes(), key)

    def test_once_can_select_a_discovery_page(self):
        with tempfile.TemporaryDirectory(prefix='nomo-page-') as tmp:
            base = Path(tmp).resolve(); workspace = base/'workspace'; workspace.mkdir(); state = base/'state'
            for page in ('0', '5', '7'):
                with self.subTest(page=page), patch.dict(os.environ, {'NOMO_STATE_DIR': str(state)}), \
                     patch.object(module.sys, 'argv', ['nomo', '--root', str(workspace), '--page', page, '--once', 'read']), \
                     patch.object(module.os, 'execv') as execute:
                    module.main(); command = execute.call_args.args[1]
                    self.assertEqual(command[command.index('--page')+1], page)
                    self.assertEqual(command[command.index('--once')+1], 'read')
            for page in ('-1', '8'):
                with self.subTest(invalid=page), patch.object(module.sys, 'argv', ['nomo', '--page', page]), \
                     patch.object(module.os, 'execv') as execute:
                    with self.assertRaises(SystemExit): module.main()
                    execute.assert_not_called()

    def test_explicit_files_disable_discovery_for_new_and_resumed_sessions(self):
        with tempfile.TemporaryDirectory(prefix='nomo-allow-') as tmp:
            base = Path(tmp).resolve(); workspace = base/'workspace'; workspace.mkdir(); state = base/'state'
            with patch.dict(os.environ, {'NOMO_STATE_DIR': str(state)}), patch.object(module.os, 'execv') as execute:
                for extra in ([], ['--id', 'a'*32]):
                    with self.subTest(resume=bool(extra)), patch.object(module.sys, 'argv', ['nomo', '--root', str(workspace), '--allow', 'src/a.py,README.md', '--once', 'read', *extra]):
                        module.main(); command = execute.call_args.args[1]
                        self.assertIn('--allow=src/a.py,README.md', command)
                        self.assertNotIn('--discover', command); self.assertNotIn('--page', command)
                        self.assertEqual(command[command.index('--once')+1], 'read')

    def test_explicit_scope_rejects_wildcards_and_conflicting_page(self):
        with tempfile.TemporaryDirectory(prefix='nomo-allow-') as tmp:
            base = Path(tmp).resolve(); workspace = base/'workspace'; workspace.mkdir(); state = base/'state'
            for value in ('*', '*4', '', 'a,,b', 'a,b,c,d,e'):
                with self.subTest(value=value), patch.dict(os.environ, {'NOMO_STATE_DIR': str(state)}), \
                     patch.object(module.sys, 'argv', ['nomo', '--root', str(workspace), '--allow', value]), \
                     patch.object(module.os, 'execv') as execute:
                    self.assertEqual(module.main(), 1); execute.assert_not_called(); self.assertFalse(state.exists())
            with patch.object(module.sys, 'argv', ['nomo', '--allow', 'a', '--page', '1']), patch.object(module.os, 'execv') as execute:
                with self.assertRaises(SystemExit): module.main()
                execute.assert_not_called()

    def test_resume_missing_state_and_overlapping_workspace_do_not_create_state(self):
        with tempfile.TemporaryDirectory(prefix='nomo-entry-') as tmp:
            base = Path(tmp).resolve(); workspace = base/'workspace'; workspace.mkdir()
            state = base/'missing'
            with patch.dict(os.environ, {'NOMO_STATE_DIR': str(state)}), \
                 patch.object(module.sys, 'argv', ['nomo', '--root', str(workspace), '--id', 'a'*32]), \
                 patch.object(module.os, 'execv') as execute:
                self.assertEqual(module.main(), 1)
                self.assertFalse(state.exists())
                execute.assert_not_called()
            nested = workspace/'state'
            with patch.dict(os.environ, {'NOMO_STATE_DIR': str(nested)}), \
                 patch.object(module.sys, 'argv', ['nomo', '--root', str(workspace)]), \
                 patch.object(module.os, 'execv') as execute:
                self.assertEqual(module.main(), 1)
                self.assertFalse(nested.exists())
                execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
