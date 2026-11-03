import contextlib
import importlib.util
import io
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('edit_diagnostic', ROOT / 'scripts/nomo-edit.py')
edit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edit)


class DiagnosticTests(unittest.TestCase):
    def report(self, observer, code=3):
        out = io.StringIO()
        with contextlib.redirect_stderr(out):
            observer.report(code)
        return out.getvalue()

    def test_fragmented_known_output_is_bounded_and_classified(self):
        observer = edit.RuntimeDiagnostic()
        payload = b'STAGE read-child child-1 steps=2 calls=1\r\n' + observer._length + b'\r\n'
        for i in range(0, len(payload), 7):
            observer.feed('stdout', payload[i:i + 7])
        report = self.report(observer)
        self.assertIn('last_stage_text=read-child text_marker=incomplete_response_length', report)
        self.assertIn('untrusted', report)
        self.assertNotIn('OpenAI-compatible', report)

    def test_503_and_ambiguous_or_unknown_errors(self):
        observer = edit.RuntimeDiagnostic()
        observer.feed('stdout', b'STAGE edit-aggregate\n' + observer._provider_503 + b'\n')
        self.assertIn('last_stage_text=edit-aggregate text_marker=provider_http_503', self.report(observer))
        observer.feed('stdout', observer._length + b'\n')
        self.assertIn('text_marker=unknown', self.report(observer))
        self.assertEqual('', self.report(observer, 0))

    def test_no_partial_or_overlong_line_can_match(self):
        observer = edit.RuntimeDiagnostic()
        observer.feed('stdout', b'x' * 513 + observer._length + b'\n' + observer._length[:-1] + b'\n')
        self.assertIn('last_stage_text=unknown text_marker=unknown', self.report(observer))
        self.assertLessEqual(len(observer.buffers['stdout']), 512)

    def test_chat_stage_is_observed_without_copying_turn_text(self):
        observer = edit.RuntimeDiagnostic()
        observer.feed('stdout', b'TURN 1 STAGE child steps=2 calls=1 tokens=2048 tools=0 scan=0 reserved_steps=5 reserved_calls=3 reserved_tokens=6144 reserved_tools=1 reserved_scan=4096\n' + observer._length + b'\n')
        self.assertIn('last_stage_text=chat-child text_marker=incomplete_response_length', self.report(observer))

    def test_post_edit_marker_is_bounded_and_advisory(self):
        observer=edit.RuntimeDiagnostic()
        for chunk in (b'POST_EDIT con',b'text\nPOST_EDIT aggre',b'gate\nPOST_EDIT persist extra\n'):
            observer.feed('stdout',chunk)
        report=self.report(observer);self.assertIn('post_edit_text=aggregate',report);self.assertIn('untrusted',report)
        observer.feed('stderr',b'POST_EDIT persist\n')
        self.assertIn('post_edit_text=persist',self.report(observer));self.assertEqual('',self.report(observer,0))

    def test_summary_bound_message_is_actionable_and_not_a_retry(self):
        observer=edit.RuntimeDiagnostic();observer.feed('stdout',b'POST_EDIT aggregate\n'+observer._summary_bound+b'\n')
        report=self.report(observer);self.assertIn('text_marker=summary_blank_or_over_limit',report);self.assertIn('may already be applied',report);self.assertIn('inspect the file and session status',report);self.assertIn('Do not automatically retry',report)

    def test_history_summary_bound_is_also_actionable(self):
        observer=edit.RuntimeDiagnostic();observer.feed('stdout',b'POST_EDIT aggregate\n'+observer._history_summary_bound+b'\n')
        self.assertIn('text_marker=summary_blank_or_over_limit',self.report(observer));self.assertIn('may already be applied',self.report(observer))

    def test_only_exact_bounded_read_refusals_are_classified(self):
        for line, category in edit.RuntimeDiagnostic._read_refusals.items():
            with self.subTest(category=category):
                observer=edit.RuntimeDiagnostic()
                observer.feed('stdout',line+b'\n')
                self.assertIn('text_marker='+category,self.report(observer))
                other=edit.RuntimeDiagnostic()
                other.feed('stdout',line+b' extra\n')
                self.assertIn('text_marker=unknown',self.report(other))

    def test_utf8_work_rejection_is_finite_and_advisory(self):
        for reason in ('blank','length','unsafe'):
            observer=edit.RuntimeDiagnostic();observer.feed('stdout',('READ_PLAN_REJECTION '+reason+'\n').encode())
            self.assertIn('plan_rejection_text='+reason,self.report(observer));self.assertIn('untrusted',self.report(observer))
        observer=edit.RuntimeDiagnostic();observer.feed('stdout',b'READ_PLAN_REJECTION blank\nREAD_PLAN_REJECTION length\n')
        self.assertIn('plan_rejection_text=unknown',self.report(observer))


if __name__ == '__main__':
    unittest.main()
