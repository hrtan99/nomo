"""User work entry keeps read, edit and check boundaries explicit."""
import importlib.util
import io
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('nomo_work', ROOT/'scripts/nomo-edit.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class WorkLauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.workspace = self.base/'workspace'; self.state = self.base/'state'; self.context = self.base/'context'
        for p in (self.workspace, self.state, self.context): p.mkdir(mode=0o700)
        (self.workspace/'note.txt').write_text('old\n')
        self.argv = ['--read-root', str(self.context), '--allow', 'context.txt', '--root', str(self.workspace),
                     '--state', str(self.state), '--id', 'one', '--path', 'note.txt', '--once', 'Update old']
        self.env = {'NOMO_READ_MODEL_BASE_URL': 'http://synthetic.test/v1', 'NOMO_QWEN_SERVER_API_KEY': 'synthetic',
                    'NOMO_MODEL_REQUEST_DEADLINE_MS': '240000'}
        root_patch = patch.object(module, 'ROOT', self.base/'project'); root_patch.start(); self.addCleanup(root_patch.stop)
        (self.base/'project').mkdir()

    def invoke(self, argv=None, results=(0,)):
        calls=[]; out=io.StringIO(); err=io.StringIO(); remaining=iter(results)
        with patch.dict(os.environ,self.env,clear=True), redirect_stdout(out), redirect_stderr(err), \
             patch.object(module.sys.stdin,'isatty',return_value=True), patch.object(module.sys.stdout,'isatty',return_value=True), \
             patch.object(module,'run_owned',side_effect=lambda cmd,env: calls.append((cmd,env.copy())) or next(remaining)):
            code=module.main(self.argv if argv is None else argv,work=True)
        return code,calls,out.getvalue(),err.getvalue()

    def test_shell_entry_dispatches_work_help(self):
        result=subprocess.run(['bash',str(ROOT/'scripts/nomo-read.sh'),'work','--help'],capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0)
        self.assertIn(b'--read-root',result.stdout);self.assertIn(b'--allow',result.stdout)

    def test_routes_read_edit_and_offline_check(self):
        code,calls,out,_=self.invoke(self.argv+['--check','true'],(0,0))
        self.assertEqual(code,0);self.assertEqual(len(calls),2)
        command,env=calls[0]; check,check_env=calls[1]
        self.assertEqual(command[command.index('--flow')+1],'harness_work')
        self.assertEqual(command[command.index('--profile')+1],'harness-work')
        self.assertEqual(command[-2:],['--allow','context.txt'])
        self.assertIn(str(self.base/'project/config/harness-work-compose.yaml'),command)
        self.assertEqual(env['NOMO_WORK_CONTEXT_DIR'],str(self.context.resolve()))
        self.assertEqual(env['NOMO_MODEL_REQUEST_DEADLINE_MS'],'240000')
        self.assertNotIn(str(self.base/'project/config/harness-work-compose.yaml'),check)
        self.assertNotIn(str(self.base/'project/config/nomo-model-edit-compose.yaml'),check)
        for name in ('NOMO_WORK_CONTEXT_DIR','NOMO_QWEN_SERVER_API_KEY','NOMO_READ_MODEL_BASE_URL','NOMO_MODEL_REQUEST_DEADLINE_MS'):
            self.assertNotIn(name,check_env)
        self.assertIn('before write confirmation',out);self.assertIn('up to 7 model calls',out)
        self.assertIn('Check passed.',out)

    def test_failed_work_never_runs_check(self):
        code,calls,out,err=self.invoke(self.argv+['--check','true'],(3,))
        self.assertEqual(code,3);self.assertEqual(len(calls),1)
        self.assertNotIn('Running the requested check',out)
        self.assertIn('remote outcome may be unknown',err)

    def test_context_and_workspace_may_be_same_but_never_state(self):
        argv=self.argv.copy();argv[1]=str(self.workspace)
        code,calls,_,_=self.invoke(argv);self.assertEqual(code,0);self.assertEqual(len(calls),1)
        for invalid in (self.state,self.base):
            argv=self.argv.copy();argv[1]=str(invalid)
            code,calls,_,_=self.invoke(argv);self.assertEqual(code,64);self.assertEqual(calls,[])

    def test_refuses_unsafe_allow_and_unsupported_task_before_launch(self):
        for allowed in ('', '../secret', '/absolute', 'a//b', 'a,a', 'a,b,c', 'x'*49):
            argv=self.argv.copy();argv[3]=allowed
            code,calls,_,_=self.invoke(argv);self.assertEqual(code,64,allowed);self.assertEqual(calls,[])
        for task in ('', ' '*3, '汉字', 'x'*129, 'line\nbreak'):
            argv=self.argv.copy();argv[-1]=task
            code,calls,_,_=self.invoke(argv);self.assertEqual(code,64,repr(task));self.assertEqual(calls,[])

    def test_requires_fresh_state_and_real_tty(self):
        (self.state/'occupied').write_text('x')
        code,calls,_,_=self.invoke();self.assertEqual(code,64);self.assertEqual(calls,[])
        (self.state/'occupied').unlink()
        with patch.dict(os.environ,self.env,clear=True), patch.object(module.sys.stdin,'isatty',return_value=False), \
             patch.object(module.sys.stdout,'isatty',return_value=True), redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()), \
             patch.object(module,'run_owned') as run:
            self.assertEqual(module.main(self.argv,work=True),64);run.assert_not_called()

if __name__ == '__main__':unittest.main()
