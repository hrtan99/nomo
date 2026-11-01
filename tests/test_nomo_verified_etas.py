"""Fail-closed checks for the selected read-only terminal runtime."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('nomo_verified_etas', ROOT / 'scripts/nomo-verified-etas.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class VerifiedEtas(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nomo-identity-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cli = self.root / 'etas'
        self.cli.write_text('#!/bin/sh\nprintf "etas 0.2.2\\n"\n')
        self.cli.chmod(0o755)
        self.lock = self.root / 'Cargo.lock'
        self.lock.write_text('synthetic lock\n')
        self.config = self.root / 'graph.json'
        self.write_config()

    def write_config(self):
        self.config.write_text(json.dumps({'selector': 'latest022',
            'verified_seed_binary_sha256': hashlib.sha256(self.cli.read_bytes()).hexdigest(),
            'cargo_lock_sha256': hashlib.sha256(self.lock.read_bytes()).hexdigest()}))

    def verify(self, selected='latest022'):
        return M.verify(self.cli, self.config, self.lock, selected)

    def test_exact_binary_lock_version_and_selector(self):
        self.assertTrue(self.verify())

    def test_wrong_selector_or_drift_is_refused(self):
        self.assertFalse(self.verify('latest'))
        self.lock.write_text('changed\n')
        self.assertFalse(self.verify())
        self.write_config()
        self.cli.write_text('#!/bin/sh\nprintf "etas 0.2.2\\n"\n# changed\n')
        self.assertFalse(self.verify())

    def test_wrong_version_and_symlink_are_refused(self):
        self.cli.write_text('#!/bin/sh\nprintf "etas 0.1.12\\n"\n')
        self.write_config()
        self.assertFalse(self.verify())
        target = self.root / 'actual'
        self.cli.rename(target)
        self.cli.symlink_to(target)
        self.assertFalse(self.verify())

    def test_invalid_configuration_never_executes_cli(self):
        self.config.write_text('{}')
        self.assertFalse(self.verify())
        with patch.object(M, 'verify', return_value=False), patch.object(M.os, 'execv') as execute:
            with redirect_stderr(io.StringIO()):
                self.assertEqual(M.main(), 1)
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
