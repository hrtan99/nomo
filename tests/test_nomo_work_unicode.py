import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('nomo_edit_unicode',ROOT/'scripts/nomo-edit.py')
edit=importlib.util.module_from_spec(spec);spec.loader.exec_module(edit)

class WorkQuestionTest(unittest.TestCase):
    def test_multilingual_and_exact_byte_boundary(self):
        for question in ('Change old to green','将 old 改为 green','港'*170+'ab','x'*512):
            with self.subTest(question=question):self.assertTrue(edit.safe_read_question(question))
        for question in ('','   ','港'*171,'x'*513):
            with self.subTest(question=question):self.assertFalse(edit.safe_read_question(question))

    def test_terminal_controls_and_invalid_unicode_are_rejected(self):
        for question in ('a\nb','a\x1bb','a\u0085b','a\u202eb','a\u2066b','a\ufeffb','a\ud800b'):
            with self.subTest(question=repr(question)):self.assertFalse(edit.safe_read_question(question))

if __name__=='__main__':unittest.main()
