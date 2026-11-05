"""Default MiniMax subscription routing and credential separation."""
import importlib.util,io,json,os,subprocess,tempfile,tomllib,unittest
from contextlib import redirect_stderr,redirect_stdout
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('nomo_minimax',ROOT/'scripts/nomo-edit.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class MiniMaxLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.workspace=self.root/'workspace';self.state=self.root/'state';self.context=self.root/'context'
        for p in (self.workspace,self.state,self.context):p.mkdir(mode=0o700)
        (self.workspace/'note.txt').write_text('before old\n')
        self.project=self.root/'project';self.project.mkdir();p=patch.object(module,'ROOT',self.project);p.start();self.addCleanup(p.stop)
        self.argv=['--read-root',str(self.context),'--allow','context.txt','--root',str(self.workspace),'--state',str(self.state),
                   '--id','owned','--path','note.txt','--once','Use context','--check','true']
    def test_profile_uses_native_openai_and_china_subscription_endpoint(self):
        config=tomllib.loads((ROOT/'etas.toml').read_text())['runtime']['profiles']
        for name in ('gateway-minimax-readonly','harness-minimax-edit','harness-minimax-work'):
            model=config[name]['model'];self.assertEqual(model['adapter'],'openai')
            self.assertEqual(model['base_url'],'https://api.minimax.cn/v1')
            self.assertEqual(model['model'],'MiniMax-M3.1-Flash');self.assertEqual(model['api_key_env'],'MINIMAX_API_KEY')
            self.assertFalse(model['allow_private']);self.assertNotIn('enable_thinking',model)
            self.assertEqual(model['retry'],{'attempts':1,'delay_ms':0})
    def test_work_defaults_to_minimax_and_cleans_check_environment(self):
        calls=[];out=io.StringIO();err=io.StringIO();env={'MINIMAX_API_KEY':'FAKE_MINIMAX_TOKEN',
            'NOMO_QWEN_SERVER_API_KEY':'FAKE_QWEN_TOKEN','NOMO_READ_MODEL_BASE_URL':'http://old.invalid/v1'}
        with patch.dict(os.environ,env,clear=True),redirect_stdout(out),redirect_stderr(err), \
             patch.object(module.sys.stdin,'isatty',return_value=True),patch.object(module.sys.stdout,'isatty',return_value=True), \
             patch.object(module,'run_owned',side_effect=lambda cmd,child: calls.append((cmd,child.copy())) or 0):
            self.assertEqual(module.main(self.argv,work=True),0)
        self.assertEqual(len(calls),2);cmd,child=calls[0];check,check_env=calls[1]
        self.assertIn(str(self.project/'config/nomo-minimax-model-compose.yaml'),cmd)
        self.assertIn(str(self.project/'config/etas-041-official-compose.yaml'),cmd)
        self.assertEqual(cmd[cmd.index('--profile')+1],'harness-minimax-work')
        self.assertEqual(child['MINIMAX_API_KEY'],'FAKE_MINIMAX_TOKEN');self.assertNotIn('NOMO_QWEN_SERVER_API_KEY',child)
        self.assertNotIn('FAKE_MINIMAX_TOKEN',repr(cmd));self.assertNotIn('FAKE_MINIMAX_TOKEN',out.getvalue()+err.getvalue())
        for key in ('MINIMAX_API_KEY','NOMO_QWEN_SERVER_API_KEY','NOMO_WORK_CONTEXT_DIR','NOMO_READ_MODEL_BASE_URL'):
            self.assertNotIn(key,check_env)
        self.assertNotIn(str(self.project/'config/nomo-minimax-model-compose.yaml'),check)
    def test_missing_key_and_bad_provider_stop_before_launch(self):
        for env in ({},{'MINIMAX_API_KEY':'synthetic','NOMO_MODEL_PROVIDER':'invalid'}):
            with self.subTest(env=env),patch.dict(os.environ,env,clear=True),redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()), \
                 patch.object(module.sys.stdin,'isatty',return_value=True),patch.object(module.sys.stdout,'isatty',return_value=True), \
                 patch.object(module,'run_owned') as runner:
                self.assertEqual(module.main(self.argv,work=True),64);runner.assert_not_called()
    def test_standalone_status_and_check_drop_minimax_key(self):
        with patch.dict(os.environ,{'MINIMAX_API_KEY':'FAKE_MINIMAX_TOKEN'},clear=True):
            _,env=module.prepare_project_check(str(self.workspace),['true'])
            self.assertNotIn('MINIMAX_API_KEY',env)
            (self.state/'edit.sqlite3').write_bytes(b'synthetic')
            _,env=module.prepare_edit_status(str(self.state),'owned','note.txt')
            self.assertNotIn('MINIMAX_API_KEY',env)
    def test_read_entry_defaults_to_minimax_without_qwen_key(self):
        bindir=self.root/'bin';bindir.mkdir();log=self.root/'log.json';docker=bindir/'docker'
        docker.write_text("#!/usr/bin/env python3\nimport json,os,sys\nif sys.argv[1:2]==['inspect']:\n print('No such object: synthetic',file=sys.stderr);sys.exit(1)\nwith open(os.environ['NOMO_TEST_LOG'],'w') as f: json.dump({'args':sys.argv[1:],'minimax':bool(os.environ.get('MINIMAX_API_KEY')),'qwen':bool(os.environ.get('NOMO_QWEN_SERVER_API_KEY'))},f)\n")
        docker.chmod(0o755);env={'PATH':str(bindir)+':/usr/bin:/bin','HOME':str(self.root),'NOMO_TEST_LOG':str(log),
                                 'MINIMAX_API_KEY':'FAKE_MINIMAX_TOKEN','NOMO_QWEN_SERVER_API_KEY':'FAKE_QWEN_TOKEN'}
        result=subprocess.run(['bash',str(ROOT/'scripts/nomo-read.sh'),'ask','--root',str(self.context),'--allow','context.txt','--once','hello'],env=env,capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr);call=json.loads(log.read_text());args=call['args']
        self.assertIn(str(ROOT/'config/nomo-minimax-read-compose.yaml'),args);self.assertIn(str(ROOT/'config/etas-041-official-compose.yaml'),args)
        self.assertEqual(args[args.index('--profile')+1],'gateway-minimax-readonly')
        self.assertTrue(call['minimax']);self.assertFalse(call['qwen']);self.assertNotIn('FAKE_MINIMAX_TOKEN',repr(args))
if __name__=='__main__':unittest.main()
