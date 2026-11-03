import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('omitted_probe',ROOT/'recoverable_followup_vertical_probe.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class OmittedCheckTest(unittest.TestCase):
    def test_matching_file_succeeds_and_emits_full_output(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'note.txt').write_text('before green\n')
            result=subprocess.run(['/bin/sh','-c',module.omitted_check()],cwd=directory,capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0)
            self.assertEqual(result.stdout,b'X'*4500)

    def test_mismatched_file_fails_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'note.txt').write_text('before wrong\n')
            result=subprocess.run(['/bin/sh','-c',module.omitted_check()],cwd=directory,capture_output=True,timeout=5)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,b'')

if __name__=='__main__':unittest.main()
