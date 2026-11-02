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

    def test_status_and_explicit_work_with_check(self):
        line = '/status\n/work op1 "/tmp/edit dir" file.txt "change this" --check python3 -m pytest\n/exit\n'
        code, _, _, calls = self.run_chat(line, codes=(0, 0))
        self.assertEqual(code, 0)
        status, work = [c.args[0] for c in calls.call_args_list]
        self.assertIn('status', status)
        self.assertIn('work', work)
        self.assertEqual(work[work.index('--root') + 1], '/tmp/edit dir')
        self.assertIn('--operation-id=op1', work)
        self.assertIn('--path=file.txt', work)
        self.assertIn('--once=change this', work)
        self.assertEqual(work[-4:], ['--check', 'python3', '-m', 'pytest'])

    def test_followup_routes_with_fresh_inputs(self):
        code, _, _, calls = self.run_chat('/followup op2 "/tmp/edit dir" file.txt "change again" --check python3 -m pytest\n/exit\n')
        self.assertEqual(code, 0)
        command = calls.call_args.args[0]
        self.assertIn('followup', command)
        self.assertIn('--operation-id=op2', command)
        self.assertIn('--once=change again', command)
        self.assertEqual(command[-4:], ['--check', 'python3', '-m', 'pytest'])

    def test_followup_option_like_values_are_single_arguments(self):
        self.args[-2:] = ['--allow=-context']
        code, _, _, calls = self.run_chat('/followup -n /tmp -file "task" --check printf -- -x\n/exit\n')
        self.assertEqual(code, 0)
        command = calls.call_args.args[0]
        self.assertIn('followup', command)
        self.assertIn('--operation-id=-n', command)
        self.assertIn('--path=-file', command)
        self.assertIn('--allow=-context', command)
        self.assertEqual(command[-4:], ['--check', 'printf', '--', '-x'])

    def test_bad_work_syntax_never_launches(self):
        code, _, err, calls = self.run_chat('/work missing\n/work op /tmp f "unclosed\n/work op /tmp f task --check\n/exit\n')
        self.assertEqual(code, 0)
        self.assertIn('REFUSED', err)
        calls.assert_not_called()

    def test_work_failure_stops_and_once_is_not_command(self):
        code, _, err, calls = self.run_chat('/work op /tmp f task\nsecond\n', codes=(1,))
        self.assertEqual(code, 1)
        self.assertIn('inspect session status', err)
        self.assertEqual(calls.call_count, 1)
        code, _, _, calls = self.run_chat('', tty=False, once='/work op /tmp f task')
        self.assertEqual(code, 0)
        self.assertIn('resume', calls.call_args.args[0])
        self.assertNotIn('work', calls.call_args.args[0])

    def test_option_like_allow_and_work_values_are_single_arguments(self):
        self.args[-2:] = ['--allow=-context']
        code, _, _, calls = self.run_chat('/work -n /tmp -file "task"\n/exit\n')
        self.assertEqual(code, 0)
        command = calls.call_args.args[0]
        self.assertIn('--operation-id=-n', command)
        self.assertIn('--path=-file', command)
        self.assertIn('--allow=-context', command)


if __name__ == '__main__':
    unittest.main()
