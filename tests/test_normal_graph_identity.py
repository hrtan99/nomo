"""Host-only graph selection guards; fake bootstraps, no CLI/network dispatch."""
from contextlib import redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('normal_graph_under_test', Path(__file__).resolve().with_name('normal_graph_identity.py'))
G = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(G)


class NormalGraphIdentityChecks(unittest.TestCase):
    def setUp(self):
        self.root = Path('/guard-fixture/project')
        self.cli = Path('/guard-fixture/bin/etas')
        self.bootstrap = SimpleNamespace(INSTALLED=self.cli, verify=Mock(return_value={'sha256': 'fixture-binary'}))
        self.loader = Mock()
        self.spec = SimpleNamespace(loader=self.loader)
        values = {self.root / 'etas.lock': G.PROJECT_LOCK_SHA256, self.cli: G.LEGACY_CLI_SHA256,
                  self.root / 'patches/etas-003/Cargo.lock': G.LEGACY_LOCK_SHA256}
        self.patches = [patch.object(G, 'ROOT', self.root), patch.dict(os.environ, {}, clear=True),
                        patch.object(G.shutil, 'which', return_value=str(self.cli)),
                        patch.object(G, 'digest', side_effect=lambda path: values.get(Path(path), 'fixture-digest')),
                        patch.object(G.importlib.util, 'spec_from_file_location', return_value=self.spec),
                        patch.object(G.importlib.util, 'module_from_spec', return_value=self.bootstrap),
                        patch('subprocess.run', side_effect=AssertionError('actual process dispatch forbidden in host-only tests'))]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def verify(self):
        with redirect_stdout(io.StringIO()):
            return G.verify_cli()

    def assert_bootstrap(self, selected, filename):
        self.assertEqual(self.verify(), self.cli)
        G.importlib.util.spec_from_file_location.assert_called_once_with('normal_' + selected + '_bootstrap', self.root / 'scripts' / filename)
        self.loader.exec_module.assert_called_once_with(self.bootstrap)
        self.bootstrap.verify.assert_called_once_with(read_only=True)

    def test_unset_selects_latest_only(self):
        self.assertEqual(G.selected_graph(), 'latest')
        self.assert_bootstrap('latest', 'etas-latest-cli-bootstrap.py')

    def test_explicit_latest(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'latest'
        self.assert_bootstrap('latest', 'etas-latest-cli-bootstrap.py')

    def test_explicit_012_uses_its_own_bootstrap(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'latest012'
        self.assert_bootstrap('latest012', 'etas-012-official-cli-bootstrap.py')

    def test_explicit_022_uses_its_own_bootstrap(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'latest022'
        self.assert_bootstrap('latest022', 'etas-022-official-cli-bootstrap.py')

    def test_official_evidence_includes_shared_guard_and_version_pins(self):
        for label in ('012', '022'):
            with self.subTest(label=label):
                os.environ['NOMO_NORMAL_GRAPH'] = 'latest' + label
                paths = G.bootstrap_evidence_paths()
                self.assertEqual(paths, [self.root / ('scripts/etas-' + label + '-official-cli-bootstrap.py'),
                                         self.root / 'scripts/etas-official-cli-common.py',
                                         self.root / 'config/etas-official-legacy-bridge.json',
                                         self.root / ('config/etas-' + label + '-official.json'),
                                         self.root / ('config/etas-' + label + '-official.Cargo.lock')])
        os.environ['NOMO_NORMAL_GRAPH'] = 'latest'
        self.assertEqual(G.bootstrap_evidence_paths(), [self.root / 'scripts/etas-latest-cli-bootstrap.py'])

    def test_explicit_009_recovery_uses_its_own_bootstrap(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'latest009'
        self.assert_bootstrap('latest009', 'etas-009-cli-bootstrap.py')

    def test_explicit_etas0013_remains_historical(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'etas0013'
        self.assert_bootstrap('etas0013', 'etas-0013-cli-bootstrap.py')

    def test_explicit_legacy_keeps_its_hash_and_lock_guard(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'legacy'
        self.assertEqual(self.verify(), self.cli)
        self.assertEqual(G.bootstrap_path(), self.root / 'scripts/etas-003-cli-bootstrap.sh')
        G.importlib.util.spec_from_file_location.assert_not_called()
        self.bootstrap.verify.assert_not_called()

    def test_unknown_selector_is_rejected_before_resolution(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'unrecorded-candidate'
        with self.assertRaisesRegex(RuntimeError, 'must be latest, latest022, latest012, latest009, legacy or etas0013'):
            self.verify()
        G.shutil.which.assert_not_called()
        G.importlib.util.spec_from_file_location.assert_not_called()

    def test_missing_cli_has_no_fallback(self):
        G.shutil.which.return_value = None
        with self.assertRaisesRegex(RuntimeError, 'not installed on PATH'):
            self.verify()
        self.bootstrap.verify.assert_not_called()

    def test_project_lock_drift_rejected(self):
        G.digest.return_value = 'wrong-lock'
        G.digest.side_effect = None
        with self.assertRaisesRegex(RuntimeError, 'normal project lock drift'):
            self.verify()
        self.bootstrap.verify.assert_not_called()

    def test_latest_verify_failure_never_tries_old_bootstrap(self):
        self.bootstrap.verify.side_effect = RuntimeError('latest graph unavailable')
        with self.assertRaisesRegex(RuntimeError, 'latest graph unavailable'):
            self.verify()
        G.importlib.util.spec_from_file_location.assert_called_once_with('normal_latest_bootstrap', self.root / 'scripts/etas-latest-cli-bootstrap.py')
        self.bootstrap.verify.assert_called_once_with(read_only=True)

    def test_missing_latest_module_never_falls_back(self):
        self.loader.exec_module.side_effect = FileNotFoundError('latest bootstrap missing')
        with self.assertRaises(FileNotFoundError):
            self.verify()
        G.importlib.util.spec_from_file_location.assert_called_once()
        self.bootstrap.verify.assert_not_called()

    def test_shadowed_path_is_rejected_after_graph_verification(self):
        self.bootstrap.INSTALLED = Path('/guard-fixture/latest/etas')
        with self.assertRaisesRegex(RuntimeError, 'PATH does not select the verified installed CLI'):
            self.verify()
        self.bootstrap.verify.assert_called_once_with(read_only=True)

    def test_legacy_wrong_binary_rejected(self):
        os.environ['NOMO_NORMAL_GRAPH'] = 'legacy'
        G.digest.side_effect = lambda path: G.PROJECT_LOCK_SHA256 if Path(path).name == 'etas.lock' else 'wrong-binary'
        with self.assertRaisesRegex(RuntimeError, 'legacy CLI hash drift'):
            self.verify()
        self.bootstrap.verify.assert_not_called()


if __name__ == '__main__':
    unittest.main()
