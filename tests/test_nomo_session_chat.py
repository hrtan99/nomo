import contextlib
import importlib.util
import io
import shlex
import signal
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

    def test_interactive_automatic_check_can_be_set_viewed_and_cleared(self):
        self.args += ['--events-policy-dir', '/private-policy']
        source = Terminal('/check python3 -c "assert 2 == 2"\n/check\nedit one\n/check --clear\nedit two\n/exit\n')
        output, error = Terminal(), io.StringIO()
        def owned(command, env, **kwargs):
            if 'diagnostic' in kwargs:
                kwargs['diagnostic'].feed('stdout', b'NATURAL WORK work file.txt\n')
            return 0
        with patch.object(module.sys, 'stdin', source), patch.object(module.sys, 'stdout', output), \
             patch.object(module.sys, 'stderr', error), patch.object(module.edit, 'run_owned', side_effect=owned) as calls:
            self.assertEqual(module.main(self.args), 0)
        self.assertEqual(error.getvalue(), '')
        first, second = [call.args[0] for call in calls.call_args_list if 'work' in call.args[0]]
        self.assertEqual(first[-4:], ['--check', 'python3', '-c', 'assert 2 == 2'])
        self.assertNotIn('--check', second)
        self.assertIn("Automatic check for future natural edits: python3 -c 'assert 2 == 2'", output.getvalue())
        self.assertIn('Automatic check for future natural edits: none', output.getvalue())

    def test_scope_can_change_between_turns_and_bad_selection_keeps_scope(self):
        code, out, error, calls = self.run_chat('/scope\n/allow src/a.py,README.md\nfirst\n/allow ../bad\nsecond\n/discover 5\nthird\n/allow file.txt\nfourth\n/exit\n', codes=(0,0,0,0))
        self.assertEqual(code, 0)
        self.assertIn('Current scope: file.txt', out); self.assertIn('.gitignore is not interpreted', out)
        self.assertIn('REFUSED /allow', error)
        scopes = [next(arg for arg in call.args[0] if arg.startswith('--allow=')) for call in calls.call_args_list]
        self.assertEqual(scopes, ['--allow=src/a.py,README.md', '--allow=src/a.py,README.md', '--allow=*5', '--allow=file.txt'])

    def test_invalid_scope_commands_do_not_dispatch(self):
        code, out, error, calls = self.run_chat('/allow\n/allow a,a\n/allow a,b,c,d,e\n/discover 8\n/exit\n')
        self.assertEqual(code, 0); self.assertEqual(error.count('REFUSED'), 4); calls.assert_not_called()

    def test_configured_check_can_run_without_a_model_turn(self):
        code, out, error, calls = self.run_chat('/check python3 -m unittest\n/check --run\n/check\n/exit\n', codes=(7,))
        self.assertEqual(code, 0); self.assertEqual(error, '')
        command = calls.call_args.args[0]
        self.assertEqual(command[-7:], ['--check-only', '--root', '/workspace', '--', 'python3', '-m', 'unittest'])
        self.assertIn('not saved in session history or sent to the model', out)
        self.assertEqual(out.count('Automatic check for future natural edits: python3 -m unittest'), 2)

    def test_event_session_records_independent_check_via_existing_work_launcher(self):
        self.args += ['--events-policy-dir', '/private-policy']
        with patch.object(module, 'session_state', return_value=Path('/private-session')):
            code, _, error, calls = self.run_chat('/check python3 test.py\n/check --run\n/exit\n', codes=(0,))
        self.assertEqual(code, 0); self.assertEqual(error, '')
        command = calls.call_args.args[0]
        self.assertIn('--independent-check', command); self.assertIn('/private-session', command)
        self.assertEqual(command[-3:], ['--check', 'python3', 'test.py'])
        self.assertIn('/private-policy', command)

    def test_running_missing_check_refuses_without_dispatch(self):
        code, _, error, calls = self.run_chat('/check --run\n/exit\n')
        self.assertEqual(code, 0); self.assertIn('configure a check', error); calls.assert_not_called()

    def test_interrupted_manual_check_stops_session(self):
        code, _, _, calls = self.run_chat('/check true\n/check --run\n', codes=(130,))
        self.assertEqual(code, 130); calls.assert_called_once()

    def test_bad_interactive_check_keeps_existing_command(self):
        code, out, error, calls = self.run_chat('/check python3 -m unittest\n/check "unterminated\n/check\n/exit\n')
        self.assertEqual(code, 0)
        self.assertIn('REFUSED', error)
        self.assertEqual(out.count('Automatic check for future natural edits: python3 -m unittest'), 2)
        calls.assert_not_called()

    def test_proposed_check_requires_confirmation_and_preserves_argv(self):
        self.args += ['--events-policy-dir', '/private-policy']
        for answer, expected in [('n', False), ('y', True)]:
            observer = module.NaturalObserver(['file.txt'])
            observer.feed('stdout', b'NATURAL CHECK python3 -c "print(1)"\n')
            source, output, error = Terminal('run test\n' + answer + '\n/exit\n'), Terminal(), io.StringIO()
            with patch.object(module.sys, 'stdin', source), patch.object(module.sys, 'stdout', output), \
                 patch.object(module.sys, 'stderr', error), patch.object(module, 'chat_turn', return_value=(0, observer)), \
                 patch.object(module, 'run_recorded_check', return_value=0) as check:
                self.assertEqual(module.main(self.args), 0)
            self.assertIn("Proposed check: python3 -c 'print(1)'", output.getvalue())
            self.assertEqual(check.called, expected)
            if expected: self.assertEqual(check.call_args.args[1], ['python3', '-c', 'print(1)'])
            else: self.assertIn('no command was run', output.getvalue())

    def test_proposed_check_failure_does_not_retry(self):
        self.args += ['--events-policy-dir', '/private-policy']
        observer = module.NaturalObserver(['file.txt']); observer.feed('stdout', b'NATURAL CHECK python3 -m unittest\n')
        with patch.object(module.sys, 'stdin', Terminal('run test\ny\n')), patch.object(module.sys, 'stdout', Terminal()), \
             patch.object(module.sys, 'stderr', io.StringIO()) as error, patch.object(module, 'chat_turn', return_value=(0, observer)), \
             patch.object(module, 'run_recorded_check', return_value=125) as check:
            self.assertEqual(module.main(self.args), 125)
        check.assert_called_once(); self.assertIn('inspect the workspace', error.getvalue())

    def test_proposed_check_setup_error_is_reported(self):
        self.args += ['--events-policy-dir', '/private-policy']
        observer = module.NaturalObserver(['file.txt']); observer.feed('stdout', b'NATURAL CHECK python3 -m unittest\n')
        with patch.object(module.sys, 'stdin', Terminal('run test\ny\n')), patch.object(module.sys, 'stdout', Terminal()), \
             patch.object(module.sys, 'stderr', io.StringIO()) as error, patch.object(module, 'chat_turn', return_value=(0, observer)), \
             patch.object(module, 'run_recorded_check', side_effect=OSError('unavailable')) as check:
            self.assertEqual(module.main(self.args), 1)
        check.assert_called_once(); self.assertIn('Check or summary could not start or complete', error.getvalue())

    def test_confirmed_check_summarizes_once_in_read_only_mode(self):
        self.args += ['--events-policy-dir', '/private-policy']
        proposal = module.NaturalObserver(['file.txt']); proposal.feed('stdout', b'NATURAL CHECK python3 -m unittest\n')
        summary = module.NaturalObserver(['file.txt']); summary.feed('stdout', b'FINAL CHECK python3 -m unittest\nNATURAL CHECK python3 -m unittest\n')
        with patch.object(module.sys, 'stdin', Terminal('run test\ny\n/exit\n')), patch.object(module.sys, 'stdout', Terminal()) as output, \
             patch.object(module.sys, 'stderr', io.StringIO()), patch.object(module, 'chat_turn', side_effect=[(0, proposal), (0, summary)]) as chat, \
             patch.object(module, 'run_recorded_check', return_value=0) as check:
            self.assertEqual(module.main(self.args), 0)
        check.assert_called_once(); self.assertEqual(chat.call_count, 2)
        self.assertIn(check.call_args.args[2], chat.call_args.args[1]); self.assertFalse(chat.call_args.args[3])
        self.assertIn('did not provide a complete summary', output.getvalue())

    def test_summary_failure_preserves_recorded_check_without_retry(self):
        self.args += ['--events-policy-dir', '/private-policy']
        proposal = module.NaturalObserver(['file.txt']); proposal.feed('stdout', b'NATURAL CHECK python3 -m unittest\n')
        summary = module.NaturalObserver(['file.txt'])
        with patch.object(module.sys, 'stdin', Terminal('run test\ny\n')), patch.object(module.sys, 'stdout', Terminal()), \
             patch.object(module.sys, 'stderr', io.StringIO()) as error, patch.object(module, 'chat_turn', side_effect=[(0, proposal), (1, summary)]), \
             patch.object(module, 'run_recorded_check', return_value=0) as check:
            self.assertEqual(module.main(self.args), 1)
        check.assert_called_once(); self.assertIn('Check remains recorded', error.getvalue())

    def test_proposed_check_rejects_unsafe_and_ambiguous_markers(self):
        for payload in (b'NATURAL CHECK python3 "unterminated\n', b'NATURAL CHECK python3 a\x1bb\n',
                        b'NATURAL CHECK one\nNATURAL CHECK two\n'):
            observer = module.NaturalObserver(['file.txt']); observer.feed('stdout', payload)
            self.assertTrue(observer.check_invalid)

    def test_unicode_path_routing_preserves_bounds_and_rejects_unsafe_paths(self):
        self.assertTrue(module.edit.safe_path('文档/说明.txt'))
        self.assertTrue(module.edit.safe_path('project docs/说明 文件.txt'))
        self.assertTrue(module.edit.safe_path('src/routes/[slug]/+page.svelte'))
        self.assertTrue(module.edit.safe_path('app/(group)/@slot/page.tsx'))
        self.assertTrue(module.edit.safe_path('中' * 42 + 'ab'))
        for value in ('中' * 43, '../说明.txt', 'a//说明.txt', 'a/ 说明.txt', 'a/说明.txt ', 'a/\u202e说明.txt', 'a/说明\\.txt'):
            self.assertFalse(module.edit.safe_path(value), value)
        observer = module.NaturalObserver(['*'])
        observer.feed('stdout', 'NATURAL WORK work 文档/说明.txt\n'.encode())
        self.assertEqual(observer.route, ('work', '文档/说明.txt'))
        observer = module.NaturalObserver(['project docs/说明 文件.txt'])
        observer.feed('stdout', 'NATURAL WORK work project docs/说明 文件.txt\n'.encode())
        self.assertEqual(observer.route, ('work', 'project docs/说明 文件.txt'))
        observer.feed('stdout', b'NATURAL WORK followup project docs/not allowed.txt\n')
        self.assertEqual(observer.route, ('work', 'project docs/说明 文件.txt'))
        observer = module.NaturalObserver(['*'])
        observer.feed('stdout', b'NATURAL WORK work bad-\xff.txt\n')
        self.assertIsNone(observer.route)

    def test_recovery_requires_user_interrupt_and_closed_cleanup_proof(self):
        self.assertFalse(module.recovery_ready(130, [0], b'', True))
        self.assertFalse(module.recovery_ready(130, [signal.SIGINT], b'', True))
        self.assertFalse(module.recovery_ready(130, [signal.SIGINT], b'clean-sigint\n', False))
        self.assertTrue(module.recovery_ready(130, [signal.SIGINT], b'clean-sigint\n', True))

    def test_multiple_turns_and_exit(self):
        code, out, _, calls = self.run_chat('/help\nfirst\nsecond\n/exit\n', codes=(0, 0))
        self.assertEqual(code, 0)
        self.assertEqual([next(arg for arg in c.args[0] if arg.startswith('--once=')) for c in calls.call_args_list], ['--once=first', '--once=second'])
        self.assertIn('SESSION ID ' + '1' * 32, out)
        self.assertIn('Resume: nomo-read.sh session-id resume', out)

    def test_eof_and_empty_input(self):
        code, _, err, calls = self.run_chat('\n')
        self.assertEqual(code, 0)
        self.assertIn('non-empty', err)
        calls.assert_not_called()

    def test_invalid_question_keeps_prompt_and_does_not_dispatch(self):
        long_chinese = '中' * 171
        accepted = '中' * 170 + 'ab'
        code, _, err, calls = self.run_chat(long_chinese + '\n' + accepted + '\n/exit\n')
        self.assertEqual(code, 0)
        self.assertIn('512', err)
        calls.assert_called_once()
        self.assertIn('--once=' + accepted, calls.call_args.args[0])

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
        self.assertEqual([next(arg for arg in c.args[0] if arg.startswith('--once=')) for c in calls.call_args_list],
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

    def test_outputs_uses_offline_status(self):
        code, _, _, calls = self.run_chat('/outputs\n/exit\n', codes=(0,))
        self.assertEqual(code, 0)
        command = calls.call_args.args[0]
        self.assertIn('status', command)
        self.assertIn('--outputs', command)

    def test_events_requires_policy_and_routes_offline_status(self):
        code,_,err,calls=self.run_chat('/events\n/exit\n')
        self.assertEqual(code,0);self.assertIn('requires event-recording mode',err);calls.assert_not_called()
        self.args+=['--events-policy-dir','/policy']
        code,_,_,calls=self.run_chat('/events\n/exit\n')
        self.assertEqual(code,0);command=calls.call_args.args[0];self.assertIn('status',command);self.assertIn('--events',command);self.assertIn('--events-policy-dir',command)

    def test_help_matches_the_selected_recording_mode(self):
        code,out,_,_=self.run_chat('/help\n/exit\n')
        self.assertEqual(code,0);self.assertIn('/outputs shows recorded check output',out);self.assertNotIn('/events displays',out)
        self.args+=['--events-policy-dir','/policy']
        code,out,_,_=self.run_chat('/help\n/exit\n')
        self.assertEqual(code,0);self.assertIn('/events displays committed events',out);self.assertNotIn('/outputs shows recorded check output',out)
        self.assertIn('without implicit shell expansion',out)

    def test_event_chat_routes_work_followup_and_check_with_policy(self):
        self.args += ['--events-policy-dir', '/private-policy']
        code, _, err, calls = self.run_chat('/work op /tmp/edit file.txt "change" --check true\n/followup op2 /tmp/edit file.txt "change"\n/status\n/exit\n', codes=(0,0,0))
        self.assertEqual(code, 0)
        self.assertEqual(err, '')
        self.assertEqual(calls.call_count, 3)
        for call in calls.call_args_list:self.assertIn('--events-policy-dir', call.args[0])
        self.assertIn('work', calls.call_args_list[0].args[0])
        self.assertEqual(calls.call_args_list[0].args[0][-2:],['--check','true'])
        self.assertIn('followup', calls.call_args_list[1].args[0])

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

    def test_failure_shows_quoted_offline_status_with_policy(self):
        self.args[1] = '/tmp/session dir'
        self.args += ['--events-policy-dir', '/tmp/policy dir']
        code, _, err, calls = self.run_chat('/work op /tmp f task\n', codes=(3,))
        self.assertEqual(code, 3); self.assertEqual(calls.call_count, 1)
        hint = next(line.removeprefix('Inspect status: ') for line in err.splitlines() if line.startswith('Inspect status: '))
        self.assertEqual(shlex.split(hint)[1:], ['session-id', 'status', '--sessions-dir=/tmp/session dir', '--id='+'1'*32, '--events-policy-dir=/tmp/policy dir'])

    def test_new_session_failure_uses_only_observed_valid_id(self):
        self.args = ['--sessions-dir', '/tmp/sessions', '--new', '--root', '/workspace', '--allow', 'file.txt']
        for observed in (True, False):
            def fail(command, env, **kwargs):
                if observed: kwargs['diagnostic'].feed('stdout', b'SESSION ID '+b'2'*32+b'\n')
                return 3
            out,err=Terminal(),io.StringIO()
            with patch.object(module.sys,'stdin',Terminal('first\n')),patch.object(module.sys,'stdout',out),patch.object(module.sys,'stderr',err),patch.object(module.edit,'run_owned',side_effect=fail) as calls:
                self.assertEqual(module.main(self.args),3)
            self.assertEqual(calls.call_count,1)
            if observed:self.assertIn('--id='+('2'*32),err.getvalue())
            else:self.assertIn('Session ID was not confirmed',err.getvalue());self.assertNotIn('Inspect status:',err.getvalue())

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
