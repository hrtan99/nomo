import subprocess
import contextlib
import importlib.util
import io
import os
import sys
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / 'scripts/nomo-bounded-check.py'
spec = importlib.util.spec_from_file_location('capture_edit', SCRIPT.with_name('nomo-edit.py'))
edit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edit)


class Output(io.StringIO):
    def __init__(self):
        super().__init__()
        self.buffer = io.BytesIO()


class BoundedCheckTest(unittest.TestCase):
    def run_check(self, code):
        return subprocess.run([sys.executable, str(SCRIPT), sys.executable, '-c', code],
                              input=b'not available', capture_output=True, timeout=10)

    def test_nonzero_and_binary_output_are_preserved(self):
        result = self.run_check('import os,sys; os.write(1,b"out\\x00\\xff"); os.write(2,b"err\\x80"); sys.exit(7)')
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, b'out\x00\xff')
        self.assertEqual(result.stderr, b'err\x80')

    def test_large_both_streams_are_drained_but_bounded(self):
        result = self.run_check('import os; os.write(1,b"a"*2000000); os.write(2,b"b"*2000000)')
        self.assertEqual(result.returncode, 0)
        self.assertTrue(result.stdout.startswith(b'a' * 65536))
        self.assertIn(b'stdout truncated after 65536 bytes', result.stdout)
        self.assertTrue(result.stderr.startswith(b'b' * 65536))
        self.assertIn(b'stderr truncated after 65536 bytes', result.stderr)
        self.assertLess(len(result.stdout), 65650)
        self.assertLess(len(result.stderr), 65650)

    def test_check_receives_eof_and_missing_command_is_error(self):
        result = self.run_check('import sys; print(repr(sys.stdin.read()))')
        self.assertEqual(result.stdout, b"''\n")
        missing = subprocess.run([sys.executable, str(SCRIPT), '/not-a-real-check'], capture_output=True, timeout=10)
        self.assertEqual(missing.returncode, 127)

    def test_long_launch_error_obeys_stderr_limit(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '/' + 'x' * 100000], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 127)
        self.assertEqual(result.stdout, b'')
        self.assertLess(len(result.stderr), 65650)
        self.assertIn(b'stderr truncated after 65536 bytes', result.stderr)

    def test_owned_capture_forwards_real_streams_and_limits_record(self):
        out, err, capture = Output(), Output(), {}
        code = 'import os,sys; os.write(1,b"a"*5000); os.write(2,b"failure"); sys.exit(7)'
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = edit.run_owned([sys.executable, '-c', code], dict(os.environ), capture)
        self.assertEqual(result, 7)
        self.assertEqual(out.buffer.getvalue(), b'a' * 5000)
        self.assertEqual(err.buffer.getvalue(), b'failure')
        self.assertEqual(bytes(capture['stdout']['data']), b'a' * 4096)
        self.assertTrue(capture['stdout']['truncated'])
        self.assertEqual(bytes(capture['stderr']['data']), b'failure')
        self.assertFalse(capture['stderr']['truncated'])

    def test_known_key_and_truncated_key_prefix_are_removed(self):
        key = 'example-long-key-value'
        env = {'MINIMAX_API_KEY': key}
        entry = {'data': bytearray(('x' + key + 'y' + key[:8]).encode()), 'truncated': True}
        self.assertEqual(edit.format_check_capture(entry, env), 'x[REDACTED]y[REDACTED]')

    def test_private_input_is_not_part_of_child_arguments(self):
        out, err, capture = Output(), Output(), {}
        command = [sys.executable, '-c', 'import sys; print(len(sys.stdin.buffer.read()))']
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = edit.run_owned(command, dict(os.environ), capture, input_data=b'private-data\n')
        self.assertEqual(result, 0)
        self.assertEqual(bytes(capture['stdout']['data']), b'13\n')
        self.assertNotIn('private-data', repr(command))


if __name__ == '__main__':
    unittest.main()
