import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('event_policy', ROOT / 'scripts/nomo-event-policy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PolicyBindingTests(unittest.TestCase):
    def test_binding_depends_on_exact_policy_and_private_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'policy.json'; file.write_bytes(b'{"format":1,"literals":["synthetic-value"]}')
            key = root / 'binding.key'; key.write_bytes(b'A' * 32)
            file.chmod(0o600); key.chmod(0o600)
            _, raw, first = module.read_private(root)
            self.assertEqual(raw, file.read_bytes())
            file.write_bytes(raw + b' ')
            _, _, second = module.read_private(root)
            self.assertNotEqual(first, second)
            key.write_bytes(b'B' * 32)
            _, _, third = module.read_private(root)
            self.assertNotEqual(second, third)
            key.chmod(0o644)
            with self.assertRaises(ValueError):module.read_private(root)

    def test_init_creates_private_key_once_without_printing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [sys.executable, '-B', str(ROOT / 'scripts/nomo-event-policy-init.py'), '--directory', tmp]
            first = subprocess.run(cmd, capture_output=True, timeout=5)
            self.assertEqual(first.returncode, 0)
            key = (Path(tmp) / 'binding.key').read_bytes()
            self.assertEqual(len(key), 32)
            self.assertEqual((Path(tmp) / 'binding.key').stat().st_mode & 0o777, 0o600)
            self.assertNotIn(key, first.stdout + first.stderr)
            second = subprocess.run(cmd, capture_output=True, timeout=5)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual((Path(tmp) / 'binding.key').read_bytes(), key)


if __name__ == '__main__':unittest.main()
