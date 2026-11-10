"""Terminal presentation and the raw protocol behind it, without model calls."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


terminal = load('terminal_display', 'nomo_terminal.py')
chat = load('terminal_chat', 'nomo-session-chat.py')


class TerminalTests(unittest.TestCase):
    def test_aligned_categories_keep_complete_preview_and_diff(self):
        sink = io.StringIO()
        stream = terminal.TerminalStream(sink, color=False)
        lines = [
            ('SESSION', 'SESSION ID ' + 'a' * 32),
            ('MODEL', 'STAGE edit-child'),
            ('TOOL', 'READ note.txt'),
            ('EDIT', 'PREVIEW {"before":"old","after":"new"}'),
            ('DIFF', '-old'), ('DIFF', '+new'),
            ('APPROVE', 'CONFIRM Apply this exact preview? [y/N]'),
            ('CHECK', 'Check passed.'), ('AGENT', 'FINAL ["完成"]'),
            ('BUDGET', 'LEDGER calls=7'), ('ERROR', 'REFUSED unavailable'),
        ]
        for _, line in lines:
            stream.write(line + '\n')
        for output, (tag, original) in zip(sink.getvalue().splitlines(), lines):
            self.assertEqual(output[:10], f'[{tag:<7}] ')
            self.assertEqual(output[10:], original)

    def test_fragmented_utf8_and_native_prompt_are_visible_before_input(self):
        sink = io.StringIO()
        stream = terminal.TerminalStream(sink, color=True)
        data = 'FINAL ["中文🚲"]\nType `yes` to approve: '.encode()
        for byte in data:
            stream.buffer.write_terminal(bytes([byte]))
        stream.flush()
        self.assertIn('中文🚲', sink.getvalue())
        self.assertIn('\x1b[1;33m[APPROVE]', sink.getvalue())
        self.assertTrue(sink.getvalue().endswith('Type `yes` to approve: '))
        stream.buffer.write_terminal(b'yes\nEDIT completed\n')
        self.assertIn('approve: yes\n', sink.getvalue())
        self.assertIn('[EDIT   ]', sink.getvalue())

    def test_rendered_child_still_supplies_raw_observer_and_capture(self):
        payload = b'SESSION ID ' + b'a' * 32 + b'\nNATURAL WORK work note.txt\nFINAL ["done"]\n'
        sink = io.StringIO()
        stdout = terminal.TerminalStream(sink, color=True)
        stderr = terminal.TerminalStream(io.StringIO(), color=True, stderr=True)
        observer = chat.NaturalObserver(['note.txt'])
        capture = {}
        with patch.object(sys, 'stdout', stdout), patch.object(sys, 'stderr', stderr):
            code = chat.edit.run_owned([sys.executable, '-c', 'import os; os.write(1, ' + repr(payload) + ')'],
                                       dict(os.environ), capture=capture, diagnostic=observer)
        self.assertEqual(code, 0)
        self.assertEqual(observer.identifier, 'a' * 32)
        self.assertEqual(observer.route, ('work', 'note.txt'))
        self.assertEqual(observer.final, '["done"]')
        self.assertEqual(capture['stdout']['data'], payload)
        self.assertIn('\x1b[36m[SESSION]', sink.getvalue())

    def test_tty_no_color_and_redirected_raw_output(self):
        class TTY(io.StringIO):
            def isatty(self):
                return True

        sink = TTY()
        with patch.dict(os.environ, {'NO_COLOR': '1'}, clear=True), \
                patch.object(sys, 'stdout', sink), patch.object(sys, 'stderr', io.StringIO()), \
                patch.object(terminal.atexit, 'register'):
            terminal.install()
            self.assertTrue(sys.stdout.isatty())
            print('STAGE plan')
            self.assertEqual(sink.getvalue(), '[MODEL  ] STAGE plan\n')
        for env, target in (({}, io.StringIO()), ({'NOMO_LOG_FORMAT': 'raw'}, TTY())):
            with patch.dict(os.environ, env, clear=True), patch.object(sys, 'stdout', target), \
                    patch.object(sys, 'stderr', io.StringIO()):
                terminal.install()
                self.assertIs(sys.stdout, target)


if __name__ == '__main__':
    unittest.main()
