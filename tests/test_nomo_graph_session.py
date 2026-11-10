"""Graph selection binds a session before any runtime or model invocation."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('graph_read', ROOT / 'scripts/nomo-read-session.py')
read = importlib.util.module_from_spec(spec)
spec.loader.exec_module(read)

class GraphSessionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.state = self.base / 'state'; self.state.mkdir(mode=0o700)
        self.root = self.base / 'root'; self.root.mkdir(mode=0o700)
        self.project = self.base / 'project'; self.project.mkdir(mode=0o700)
        self.patches = [patch.object(read, 'ROOT', self.project), patch.dict(os.environ, {'MINIMAX_API_KEY':'synthetic'}, clear=True)]
        for item in self.patches: item.start(); self.addCleanup(item.stop)
    def run_session(self, args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return read.main(args)
    def create(self):
        return self.run_session(['new', '--root', str(self.root), '--state', str(self.state), '--allow', 'a.txt', '--once', 'read'])
    def status(self):
        return self.run_session(['status', '--state', str(self.state)])
    def test_new_session_uses_030_and_refuses_an_older_runtime(self):
        with patch.object(read, 'run_owned', return_value=0) as run:
            self.assertEqual(self.create(), 0); run.assert_called_once()
        lock = self.state / '.nomo-session.lock'
        self.assertEqual(lock.read_bytes(), b'latest0120\n')
        (self.state / 'history.sqlite3').write_bytes(b'synthetic')
        with patch.object(read, 'run_owned', return_value=0) as run:
            self.assertEqual(self.status(), 0); run.assert_called_once(); run.reset_mock()
            with patch.dict(os.environ, {'NOMO_ETAS_GRAPH':'026-v68'}):
                self.assertNotEqual(self.status(), 0); run.assert_not_called()
    def test_historical_session_markers_are_preserved_under_030(self):
        lock = self.state / '.nomo-session.lock'; lock.touch(mode=0o600)
        (self.state / 'history.sqlite3').write_bytes(b'synthetic')
        for marker in (b'', b'026-v68\n', b'030-20261104-a\n', b'030-pr67\n'):
            with self.subTest(marker=marker):
                lock.write_bytes(marker)
                with patch.object(read, 'run_owned', return_value=0) as run:
                    self.assertEqual(self.status(), 0); run.assert_called_once()
                self.assertEqual(lock.read_bytes(), marker)
    def test_unknown_marker_or_selector_refuses_without_runtime(self):
        lock = self.state / '.nomo-session.lock'; lock.write_bytes(b'unknown\n'); lock.chmod(0o600)
        (self.state / 'history.sqlite3').write_bytes(b'synthetic')
        with patch.object(read, 'run_owned') as run:
            self.assertNotEqual(self.status(), 0); run.assert_not_called()
            lock.write_bytes(b'')
            with patch.dict(os.environ, {'NOMO_ETAS_GRAPH':'unknown'}):
                self.assertNotEqual(self.status(), 0); run.assert_not_called()
    def test_existing_data_not_marked_as_new_graph(self):
        (self.state / 'history.sqlite3').write_bytes(b'synthetic')
        with patch.dict(os.environ, {'NOMO_ETAS_GRAPH':'latest0120'}), patch.object(read, 'run_owned') as run:
            self.assertNotEqual(self.create(), 0); run.assert_not_called()
        self.assertEqual((self.state / '.nomo-session.lock').read_bytes(), b'')

if __name__ == '__main__': unittest.main()
