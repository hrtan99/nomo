"""A broken terminal sink must not abandon the owned subprocess."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent

CHILD = '''import os,pathlib,signal,sys,time
ready,go,cleaned=map(pathlib.Path,sys.argv[1:4])
output_fd=int(sys.argv[4])
def stop(number,frame):
    cleaned.write_text('stopped')
    raise SystemExit(143)
signal.signal(signal.SIGTERM,stop)
ready.write_text(str(os.getpid()))
while not go.exists():time.sleep(.01)
os.write(output_fd,b'output after sink closes\\n')
while True:time.sleep(.05)
'''
DRIVER = '''import importlib.util,os,sys
s=importlib.util.spec_from_file_location('edit',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
result=m.run_owned([sys.executable,'-c',sys.argv[2],*sys.argv[3:]],dict(os.environ),diagnostic=m.RuntimeDiagnostic())
raise SystemExit(result)
'''
OBSERVER_DRIVER = DRIVER.replace('diagnostic=m.RuntimeDiagnostic()',
                                 'diagnostic=type("BadObserver",(),{"feed":lambda *args: (_ for _ in ()).throw(OSError("synthetic collection failure"))})()')


class ForwardingFailureTests(unittest.TestCase):
    def assert_closed_sink_stops_child(self, closed_stream):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ready, go, cleaned = (root / item for item in ('ready', 'go', 'cleaned'))
            proc = subprocess.Popen([sys.executable, '-B', '-c', DRIVER, str(ROOT / 'scripts/nomo-edit.py'),
                                     CHILD, str(ready), str(go), str(cleaned), str(1 if closed_stream == 'stdout' else 2)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child_pid = None
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(ready.exists())
                child_pid = int(ready.read_text())
                getattr(proc, closed_stream).close()
                go.touch()
                code = proc.wait(timeout=8)
                self.assertEqual(code, 125)
                self.assertEqual(cleaned.read_text(), 'stopped')
                if closed_stream == 'stdout':
                    self.assertIn(b'outcome may be uncertain', proc.stderr.read())
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
                child_pid = None
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=3)
                if proc.stderr:
                    proc.stderr.close()
                if proc.stdout:
                    proc.stdout.close()
                if child_pid is not None:
                    try:
                        os.kill(child_pid, 9)
                    except ProcessLookupError:
                        pass

    def test_closed_stdout_stops_and_reaps_owned_child(self):
        self.assert_closed_sink_stops_child('stdout')

    def test_closed_stderr_stops_and_reaps_owned_child(self):
        self.assert_closed_sink_stops_child('stderr')

    def test_observer_failure_stops_and_reaps_owned_child(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ready, go, cleaned = (root / item for item in ('ready', 'go', 'cleaned'))
            proc = subprocess.Popen([sys.executable, '-B', '-c', OBSERVER_DRIVER, str(ROOT / 'scripts/nomo-edit.py'),
                                     CHILD, str(ready), str(go), str(cleaned), '1'],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child_pid = None
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(ready.exists())
                child_pid = int(ready.read_text())
                go.touch()
                stdout, stderr = proc.communicate(timeout=8)
                self.assertEqual(proc.returncode, 125)
                self.assertIn(b'output after sink closes', stdout)
                self.assertIn(b'outcome may be uncertain', stderr)
                self.assertEqual(cleaned.read_text(), 'stopped')
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
                child_pid = None
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=3)
                if child_pid is not None:
                    try:
                        os.kill(child_pid, 9)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
