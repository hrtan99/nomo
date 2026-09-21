"""Graph validator regression tests; fake metadata never builds or writes a graph."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[3] / 'scripts/etas-013-isolated.py'
SPEC = importlib.util.spec_from_file_location('graph', SCRIPT)
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)


class GraphValidation(unittest.TestCase):
    def metadata(self):
        return {'packages': [dict(name=package, source=None,
                                 manifest_path=f'/validation/{name}/crates/{package}/Cargo.toml')
                             for name, (_, _, _, packages) in GRAPH.PINS.items()
                             for package in packages.split()]}

    def check(self, data):
        with patch.object(GRAPH, 'cargo', return_value=json.dumps(data)), \
             patch.object(GRAPH, 'save'), patch.object(GRAPH, 'digest', return_value='lock'):
            return GRAPH.graph('cli', True)

    def test_exact_full_mapping(self):
        self.assertEqual(self.check(self.metadata()), 'lock')
        config = GRAPH.config_text('cli')
        self.assertEqual(config.count('path = '), 14)
        self.assertNotIn('branch =', config)

    def test_duplicate_origin_refused(self):
        data = self.metadata()
        data['packages'].append(data['packages'][0])
        with self.assertRaises(AssertionError):
            self.check(data)

    def test_git_origin_refused_even_if_name_matches(self):
        data = self.metadata()
        data['packages'][0]['source'] = 'git+https://github.com/etas-project/etas-core.git#wrong'
        with self.assertRaises(AssertionError):
            self.check(data)

    def test_wrong_local_origin_refused(self):
        data = self.metadata()
        data['packages'][0]['manifest_path'] = '/home/nomo/.cargo/accepted/Cargo.toml'
        with self.assertRaises(AssertionError):
            self.check(data)

    def test_missing_package_refused(self):
        data = self.metadata()
        data['packages'].pop()
        with self.assertRaises(AssertionError):
            self.check(data)

    def test_empty_graph_refused(self):
        with self.assertRaises(AssertionError):
            self.check({'packages': []})


if __name__ == '__main__':
    unittest.main()
