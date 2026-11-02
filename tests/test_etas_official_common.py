"""Version isolation and provenance controls for shared official bootstraps."""
import importlib.util
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def load(label):
    path = ROOT / ('scripts/etas-' + label + '-official-cli-bootstrap.py')
    spec = importlib.util.spec_from_file_location('test_official_' + label, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OfficialBootstrapSharing(unittest.TestCase):
    def test_each_import_keeps_its_own_graph(self):
        old, new, latest, candidate = load('012'), load('022'), load('023'), load('024')
        self.assertEqual(old._common.SELECTOR, 'latest012')
        self.assertEqual(new._common.SELECTOR, 'latest022')
        self.assertEqual(latest._common.SELECTOR, 'latest023')
        self.assertEqual(candidate._common.SELECTOR, 'latest024')
        self.assertNotEqual(old.ROOT, new.ROOT)
        self.assertNotEqual(old._common.BOOTSTRAP_SHA, new._common.BOOTSTRAP_SHA)
        self.assertEqual(old._common.SELECTOR, 'latest012')

    def test_known_legacy_and_composite_identity_are_revalidated(self):
        for label in ('012', '022', '023'):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                wrapper = load(label)
                common = wrapper._common
                folder = Path(directory)
                identity = {'pins': common.PINS, 'configuration_sha256': 'fixture-config',
                    'lock_sha256': 'fixture-lock', 'rustc': 'fixture-rustc', 'cargo': 'fixture-cargo',
                    'metadata_sha256': 'fixture-metadata', 'origins_sha256': 'fixture-origins'}
                (folder / 'cli-metadata.json').write_text('{}')
                (folder / 'cli-origins.json').write_text('{}')
                with patch.object(common, 'ROOT', folder), patch.object(common, 'SOURCE', folder / 'source'), \
                     patch.object(common, 'guard_environment'), patch.object(common, 'git_guard') as git_guard, \
                     patch.object(common, 'digest', side_effect=lambda path: {
                         common.CONFIG: 'fixture-config', common.LOCK: 'fixture-lock',
                         folder / 'source/Cargo.lock': 'fixture-lock', folder / 'cli-metadata.json': 'fixture-metadata',
                         folder / 'cli-origins.json': 'fixture-origins'}[path]), \
                     patch.object(common, 'read', side_effect=lambda args: 'fixture-rustc' if args[0]=='rustc' else 'fixture-cargo'), \
                     patch.object(common, 'graph_guard', return_value={}), patch.object(common, 'registry_guard') as registry:
                    values = [(common.BOOTSTRAP_SHA, 'shared-verified'), (common.PREVIOUS_BOOTSTRAP, 'shared-verified')]
                    if common.LEGACY_SHA is not None: values.append((common.LEGACY_SHA, 'legacy-revalidated'))
                    if common.PREVIOUS_SHARED is not None: values.append((common.PREVIOUS_SHARED, 'shared-verified'))
                    for value, expected in values:
                        identity['bootstrap_sha256'] = value
                        (folder / 'identity.json').write_text(json.dumps(identity))
                        self.assertEqual(common.guard(read_only=True), expected)
                    identity['bootstrap_sha256'] = 'unrecognized'
                    (folder / 'identity.json').write_text(json.dumps(identity))
                    with self.assertRaisesRegex(RuntimeError, 'bootstrap drift'):
                        common.guard(read_only=True)
                    self.assertEqual(git_guard.call_count, len(values))
                    self.assertEqual(registry.call_count, len(values))

    def test_reviewed_bridge_rejects_shared_implementation_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'scripts').mkdir()
            (base / 'config').mkdir()
            common_path = base / 'scripts/etas-official-cli-common.py'
            shutil.copyfile(ROOT / 'scripts/etas-official-cli-common.py', common_path)
            shutil.copyfile(ROOT / 'config/etas-022-official.json', base / 'config/etas-022-official.json')
            wrapper = base / 'scripts/etas-022-official-cli-bootstrap.py'
            shutil.copyfile(ROOT / 'scripts/etas-022-official-cli-bootstrap.py', wrapper)
            shutil.copyfile(ROOT / 'config/etas-official-legacy-bridge.json', base / 'config/etas-official-legacy-bridge.json')
            spec = importlib.util.spec_from_file_location('copied_common', common_path)
            common = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(common)
            common.configure('022', wrapper)
            before = common.BOOTSTRAP_SHA
            common_path.write_text(common_path.read_text() + '\n# changed fixture\n')
            with self.assertRaisesRegex(RuntimeError, 'shared bootstrap drift'):
                common.configure('022', wrapper)
            bridge_path = base / 'config/etas-official-legacy-bridge.json'
            bridge = json.loads(bridge_path.read_text())
            bridge['022']['common_sha256'] = hashlib.sha256(common_path.read_bytes()).hexdigest()
            bridge_path.write_text(json.dumps(bridge))
            common.configure('022', wrapper)
            self.assertNotEqual(before, common.BOOTSTRAP_SHA)

    def test_new_023_graph_has_no_legacy_or_previous_shared_provenance(self):
        common = load('023')._common
        self.assertIsNone(common.LEGACY_SHA)
        self.assertIsNone(common.PREVIOUS_SHARED)


if __name__ == '__main__':
    unittest.main()
