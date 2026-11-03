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
