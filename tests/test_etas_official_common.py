"""Preparation guard for the selected official toolchain; no build or network."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def load():
    path = ROOT / 'scripts/etas-02413-official-cli-bootstrap.py'
    spec = importlib.util.spec_from_file_location('test_current_toolchain', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OfficialBootstrapPreparation(unittest.TestCase):
    def test_fresh_graph_refuses_existing_binary_and_partial_root(self):
        common = load()._common
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); root = folder / 'graph'; binary = folder / 'bin' / 'etas'
            binary.parent.mkdir(); binary.write_bytes(b'preserve')
            with patch.object(common, 'guard_environment'), patch.object(common, 'ROOT', root), patch.object(common, 'INSTALLED', binary), patch.object(common, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'refuse replacement'): common.prepare()
                self.assertEqual(binary.read_bytes(), b'preserve'); self.assertFalse(root.exists()); run.assert_not_called()
                binary.unlink(); root.mkdir()
                with self.assertRaisesRegex(RuntimeError, 'pre-existing unowned'): common.prepare()
                self.assertTrue(root.is_dir()); run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
