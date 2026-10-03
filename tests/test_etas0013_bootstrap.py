"""Pure regression checks for the exact-graph bootstrap guards (no network/build)."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('bootstrap', Path(__file__).resolve().parents[1]
                                            / 'scripts/etas-0013-cli-bootstrap.py')
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)


class BootstrapChecks(unittest.TestCase):
    def packages(self):
        return [{'name': p, 'source': None,
                 'manifest_path': str(B.SOURCE / n / 'crates' / p / 'Cargo.toml')}
                for n, pin in B.PINS.items() for p in pin[3].split()]

    def test_distributed_locks(self):
        for name, sha in B.LOCKS.items():
            self.assertEqual(B.digest(B.REPO / 'patches/etas-0013' / f'{name}.Cargo.lock'), sha)

    def test_complete_local_cli_graph(self):
        self.assertEqual(len(B.metadata_origins('cli', {'packages': self.packages()})), 18)

    def test_remote_origin_refuses(self):
        packages = self.packages()
        packages[0]['source'] = 'git+https://example.invalid/mixed'
        with self.assertRaisesRegex(RuntimeError, 'mixed Etas origin'):
            B.metadata_origins('cli', {'packages': packages})

    def test_wrong_path_refuses(self):
        packages = self.packages()
        packages[0]['manifest_path'] = '/validation/core/Cargo.toml'
        with self.assertRaisesRegex(RuntimeError, 'wrong Etas path'):
            B.metadata_origins('cli', {'packages': packages})

    def test_duplicate_and_missing_refuse(self):
        packages = self.packages()
        for changed in (packages + [packages[0]], packages[1:]):
            with self.assertRaises(RuntimeError):
                B.metadata_origins('cli', {'packages': changed})

    def test_configs_only_preceding_exact_sources(self):
        self.assertEqual(B.config_text('core'), '\n')
        self.assertNotIn('/src/cli/', B.config_text('cli'))
        self.assertNotIn('/validation/', B.config_text('cli'))
        self.assertEqual(B.config_text('cli').count(' = { path = '), 14)

    def config_refuses(self, filename):
        for directory in ('', '.cargo'):
            with self.subTest(directory=directory), tempfile.TemporaryDirectory() as temporary:
                cache = Path(temporary).resolve()
                root = cache / 'etas0013'
                config = cache / directory / filename
                config.parent.mkdir(exist_ok=True)
                environment = {'CARGO_HOME': str(cache), 'CARGO_TARGET_DIR': str(root / 'target')}
                with patch.object(B, 'CACHE', cache), patch.object(B, 'ROOT', root), \
                        patch.object(B, 'SOURCE', root / 'src'), patch.dict(os.environ, environment, clear=True), \
                        patch.object(B.platform, 'system', return_value='Linux'), \
                        patch.object(B.platform, 'machine', return_value='aarch64'):
                    B.environment_guard()
                    config.write_text('[build]\n')
                    with self.assertRaisesRegex(RuntimeError, 'unexpected Cargo config'):
                        B.environment_guard()

    def test_cache_and_parent_dotcargo_config_refuse(self):
        self.config_refuses('config')

    def test_cache_and_parent_dotcargo_config_toml_refuse(self):
        self.config_refuses('config.toml')

    def test_readonly_verify_never_uses_logging_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'target/release/etas'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'fixture executable')
            installed = root / 'etas'
            installed.write_bytes(binary.read_bytes())
            expected = {'sha256': B.digest(binary), 'version': 'test-version\n'}
            (root / 'binary.json').write_text(json.dumps(expected))
            with patch.object(B, 'ROOT', root), patch.object(B, 'INSTALLED', installed), \
                    patch.object(B, 'guard') as guard, patch.object(B, 'run') as run, \
                    patch.object(B, 'read', return_value=expected['version']):
                self.assertEqual(B.verify(read_only=True), expected)
                guard.assert_called_once_with(read_only=True)
                run.assert_not_called()
                installed.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'installed CLI hash drift'):
                    B.verify(read_only=True)


if __name__ == '__main__':
    unittest.main()
