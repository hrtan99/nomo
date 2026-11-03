import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('nomo_deferred_chat', ROOT/'scripts/nomo-session-chat.py')
chat = importlib.util.module_from_spec(spec); spec.loader.exec_module(chat)

class DeferredOnceTests(unittest.TestCase):
    def run_case(self, markers):
        args=['--sessions-dir','/tmp/sessions','--id','a'*32,'--root','/tmp/workspace','--allow','note.txt','--once','Read the file']
        calls=[]
        def run(command, env, **options):
            calls.append((command, options))
            marker=markers[len(calls)-1]
            if marker: options['diagnostic'].feed('stdout', marker+b'\n')
            return 0
        with patch.object(chat.sys,'stdin',io.StringIO()), patch.object(chat.sys,'stdout',io.StringIO()), \
             patch.object(chat.sys,'stderr',io.StringIO()), patch.object(chat.edit,'run_owned',side_effect=run):
            result=chat.main(args)
        return result,calls

    def test_one_additional_read_is_not_an_edit(self):
        result,calls=self.run_case([b'NATURAL DELEGATE',None])
        self.assertEqual(result,0);self.assertEqual(len(calls),2)
        for command,options in calls:
            self.assertNotIn('--natural-work',command)
            self.assertEqual(options['input_data'],b'')

    def test_second_delegation_returns_failure_without_third_turn(self):
        result,calls=self.run_case([b'NATURAL DELEGATE',b'NATURAL DELEGATE'])
        self.assertEqual(result,1);self.assertEqual(len(calls),2)

if __name__ == '__main__':unittest.main()
