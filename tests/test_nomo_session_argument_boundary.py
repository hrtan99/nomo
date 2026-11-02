import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('session_id_boundary', ROOT / 'scripts/nomo-session-id.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArgumentBoundaryTest(unittest.TestCase):
    def test_child_parsers_receive_option_like_and_unicode_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            identifier = '2' * 32
            (base / identifier).mkdir(mode=0o700)
            for value in ('--help', '--root', '-n', 'a b', '中文'):
                for action in ('resume', 'work'):
                    with self.subTest(value=value, action=action):
                        args = [action, '--sessions-dir', tmp, '--id', identifier]
                        if action == 'resume':
                            args += ['--root', '/tmp', '--allow', 'f']
                        else:
                            args += ['--read-root', '/tmp', '--root', '/tmp', '--allow', 'f', '--operation-id', 'op', '--path', 'f']
                        args += ['--once=' + value]
                        def launch(command, env):
                            self.assertIn('--once=' + value, command)
                            env = dict(env, MINIMAX_API_KEY='local-test-placeholder')
                            result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=10)
                            self.assertEqual(result.returncode, 1, result.stderr)
                            self.assertIn('REFUSED', result.stdout + result.stderr)
                            self.assertNotIn('usage:', result.stderr)
                            return 0
                        with patch.object(module._edit, 'run_owned', side_effect=launch):
                            self.assertEqual(module.main(args), 0)


if __name__ == '__main__':
    unittest.main()
