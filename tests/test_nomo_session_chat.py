import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('session_chat', ROOT / 'scripts/nomo-session-chat.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Terminal(io.StringIO):
    def isatty(self):
        return True


class SessionChatTest(unittest.TestCase):
    def setUp(self):
        self.args = ['--sessions-dir', '/tmp/sessions', '--id', '1' * 32,
                     '--root', '/workspace', '--allow', 'file.txt']

    def run_chat(self, lines, *, tty=True, once=None, codes=(0,)):
        source = Terminal(lines) if tty else io.StringIO(lines)
        output = Terminal() if tty else io.StringIO()
        error = io.StringIO()
        args = self.args + ([] if once is None else ['--once', once])
        with patch.object(module.sys, 'stdin', source), patch.object(module.sys, 'stdout', output), \
             patch.object(module.sys, 'stderr', error), patch.object(module.edit, 'run_owned', side_effect=codes) as call:
            code = module.main(args)
        return code, output.getvalue(), error.getvalue(), call

    def test_multiple_turns_and_exit(self):
        code, out, _, calls = self.run_chat('/help\nfirst\nsecond\n/exit\n', codes=(0, 0))
        self.assertEqual(code, 0)
        self.assertEqual([c.args[0][-1] for c in calls.call_args_list], ['--once=first', '--once=second'])
        self.assertIn('SESSION ID ' + '1' * 32, out)
        self.assertIn('Resume: nomo-read.sh session-id resume', out)

    def test_eof_and_empty_input(self):
        code, _, err, calls = self.run_chat('\n')
        self.assertEqual(code, 0)
        self.assertIn('non-empty', err)
        calls.assert_not_called()

    def test_non_tty_requires_explicit_one_shot(self):
        code, _, _, calls = self.run_chat('first\nsecond\n', tty=False)
        self.assertEqual(code, 64)
        calls.assert_not_called()
        code, _, _, calls = self.run_chat('ignored\n', tty=False, once='first')
        self.assertEqual(code, 0)
        self.assertEqual(calls.call_count, 1)
        self.assertEqual(calls.call_args.args[0][-1], '--once=first')

    def test_option_like_and_unicode_are_one_argument(self):
        code, _, _, calls = self.run_chat('--help\n--root x\n-n\n空 格\n/exit\n', codes=(0, 0, 0, 0))
        self.assertEqual(code, 0)
        self.assertEqual([c.args[0][-1] for c in calls.call_args_list],
                         ['--once=--help', '--once=--root x', '--once=-n', '--once=空 格'])

    def test_failure_or_cancellation_stops_loop(self):
        for result in (1, 125, 130):
            code, _, err, calls = self.run_chat('first\nsecond\n', codes=(result,))
            self.assertEqual(code, result)
            self.assertEqual(calls.call_count, 1)
            self.assertIn('inspect session status', err)


if __name__ == '__main__':
    unittest.main()
