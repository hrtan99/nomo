"""Real subprocess checks for interruption of the two-phase edit launcher."""
import importlib.util
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('edit_cancel', ROOT / 'scripts/nomo-edit.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CancellationTests(unittest.TestCase):
    def test_interruption_waits_for_owned_child_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ready, finished = root / 'ready', root / 'finished'
            child = '''import pathlib,signal,sys,time
ready,finished=map(pathlib.Path,sys.argv[1:])
def stop(number,frame):
 time.sleep(.25);finished.write_text('cleanup complete');raise SystemExit(143)
signal.signal(signal.SIGTERM,stop)
ready.write_text('ready')
while True:time.sleep(.05)
'''
            driver = '''import importlib.util,os,sys
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
raise SystemExit(m.run_owned([sys.executable,'-c',sys.argv[2],sys.argv[3],sys.argv[4]],dict(os.environ)))
'''
            proc = subprocess.Popen([sys.executable, '-B', '-c', driver, str(ROOT/'scripts/nomo-edit.py'), child,
                                     str(ready), str(finished)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                until = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < until:
                    time.sleep(.02)
                self.assertTrue(ready.exists())
                proc.send_signal(signal.SIGTERM)
                _, stderr = proc.communicate(timeout=5)
                self.assertEqual(proc.returncode, 143)
                self.assertIn(b'Cancellation was requested.', stderr)
                self.assertEqual(finished.read_text(), 'cleanup complete')
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.communicate(timeout=3)

    def test_sigint_is_forwarded_and_waited(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / 'ready'
            child = "import pathlib,signal,sys,time; signal.signal(signal.SIGINT,lambda n,f:sys.exit(130)); pathlib.Path(sys.argv[1]).touch(); time.sleep(20)"
            driver = "import importlib.util,os,sys; s=importlib.util.spec_from_file_location('m',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.exit(m.run_owned([sys.executable,'-c',sys.argv[2],sys.argv[3]],dict(os.environ)))"
            proc = subprocess.Popen([sys.executable, '-B', '-c', driver, str(ROOT/'scripts/nomo-edit.py'), child, str(ready)])
            try:
                until = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < until:
                    time.sleep(.02)
                self.assertTrue(ready.exists())
                proc.send_signal(signal.SIGINT)
                self.assertEqual(proc.wait(timeout=5), 130)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=3)

    def test_unconfirmed_child_cleanup_returns_125(self):
        code = module.run_owned([sys.executable, '-c', 'raise SystemExit(125)'], dict(os.environ))
        self.assertEqual(code, 125)

    def test_exit_130_alone_does_not_claim_cancellation(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = module.run_owned([sys.executable, '-c', 'raise SystemExit(130)'], dict(os.environ))
        self.assertEqual(code, 130)
        self.assertNotIn('Cancellation was requested.', stderr.getvalue())

    def test_interrupted_edit_never_starts_check(self):
        argv = ['--root','/x','--state','/y','--id','i','--path','a','--target','old','--replacement','new', '--check','true']
        with patch.object(module, 'prepare', return_value=(['edit'], ['check'], {})), \
             patch.object(module, 'run_owned', return_value=143) as run:
            self.assertEqual(module.main(argv), 143)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0], ['edit'])

if __name__ == '__main__':
    unittest.main()
