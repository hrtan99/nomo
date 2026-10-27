#!/usr/bin/env python3
"""Local engineering checks; the Docker executable is a recording test double."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
PREPARE = ROOT/'scripts/prepare-local-tryout.py'
LAUNCH = ROOT/'scripts/local-tryout.sh'
TOKEN = 'owned-local-tryout-synthetic-key'


def clean_environment():
    env = dict(os.environ)
    for name in list(env):
        if name.startswith(('ETAS_HOST_MODEL', 'ETAS_HOST_OMLX', 'NOMO_QWEN', 'NOMO_GATEWAY')):
            env.pop(name)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env


def invoke(*args, environment=None):
    return subprocess.run([sys.executable, str(PREPARE), *map(str,args)], env=environment or clean_environment(), capture_output=True, timeout=10)


class FixtureCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nomo-tryout-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name).resolve()
        self.directory = self.parent/'owned'

    def prepare(self):
        result = invoke(self.directory)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return result


class SetupTests(FixtureCase):
    def test_fixed_private_templates(self):
        self.prepare()
        self.assertEqual({p.name for p in self.directory.iterdir()}, {'.nomo-local-tryout','context','workspace','state'})
        self.assertEqual((self.directory/'.nomo-local-tryout').read_bytes(), b'nomo-local-tryout-v1\n')
        self.assertEqual((self.directory/'context/demo/context.txt').read_bytes(), b'blue\n')
        self.assertEqual((self.directory/'workspace/demo/value.txt').read_bytes(), b'old\n')
        self.assertEqual(list((self.directory/'state').iterdir()), [])
        for path in [self.directory, *self.directory.rglob('*')]:
            self.assertFalse(path.is_symlink())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600, str(path))
        self.assertEqual(invoke('--check',self.directory).returncode,0)

    def test_existing_directory_collision_preserves_bytes_and_modes(self):
        self.directory.mkdir(mode=0o750)
        sentinel=self.directory/'sentinel';sentinel.write_bytes(b'preserve-existing-data')
        before=(sentinel.read_bytes(), self.directory.stat().st_mode)
        self.assertNotEqual(invoke(self.directory).returncode,0)
        self.assertEqual((sentinel.read_bytes(), self.directory.stat().st_mode),before)

    def test_existing_file_and_symlink_collision(self):
        self.directory.write_bytes(b'keep')
        self.assertNotEqual(invoke(self.directory).returncode,0)
        self.assertEqual(self.directory.read_bytes(),b'keep')
        self.directory.unlink()
        target=self.parent/'target';target.mkdir();(target/'keep').write_bytes(b'keep')
        self.directory.symlink_to(target,target_is_directory=True)
        self.assertNotEqual(invoke(self.directory).returncode,0)
        self.assertTrue(self.directory.is_symlink())
        self.assertEqual((target/'keep').read_bytes(),b'keep')

    def test_check_preserves_edited_file_and_opaque_state(self):
        self.prepare()
        target=self.directory/'workspace/demo/value.txt';target.write_bytes(b'blue\n');target.chmod(0o640)
        opaque=self.directory/'state/trace-opaque.json';opaque.write_bytes(b'opaque fixture state');opaque.chmod(0o600)
        before={str(p.relative_to(self.directory)):(p.read_bytes(),p.stat().st_mode) for p in self.directory.rglob('*') if p.is_file()}
        self.assertEqual(invoke('--check',self.directory).returncode,0)
        after={str(p.relative_to(self.directory)):(p.read_bytes(),p.stat().st_mode) for p in self.directory.rglob('*') if p.is_file()}
        self.assertEqual(after,before)

    def test_check_refuses_unknown_root_entry_and_changed_context(self):
        self.prepare();extra=self.directory/'arbitrary-repository';extra.mkdir()
        self.assertNotEqual(invoke('--check',self.directory).returncode,0);extra.rmdir()
        path=self.directory/'context/demo/context.txt';path.write_bytes(b'changed template')
        self.assertNotEqual(invoke('--check',self.directory).returncode,0)
        self.assertEqual(path.read_bytes(),b'changed template')

    def test_check_refuses_symlink_and_hardlink_leaves(self):
        self.prepare();target=self.parent/'outside';target.write_bytes(b'outside')
        link=self.directory/'state/link';link.symlink_to(target)
        self.assertNotEqual(invoke('--check',self.directory).returncode,0);link.unlink()
        os.link(target,link)
        self.assertNotEqual(invoke('--check',self.directory).returncode,0)
        self.assertEqual(target.read_bytes(),b'outside')


class LauncherTests(FixtureCase):
    def setUp(self):
        super().setUp()
        self.record=self.parent/'docker.json'
        fake=self.parent/'bin';fake.mkdir()
        script=fake/'docker'
        script.write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nkeys=[k for k in os.environ if k.startswith(('ETAS_HOST_MODEL','ETAS_HOST_OMLX','NOMO_QWEN','NOMO_GATEWAY'))]\nr={'argv':sys.argv[1:],'model_env_keys':sorted(keys),'state':os.environ.get('NOMO_EDIT_STATE_DIR'),'workspace':os.environ.get('NOMO_EDIT_WORKSPACE_DIR'),'context':os.environ.get('NOMO_WORK_CONTEXT_DIR')}\nPath(os.environ['NOMO_TRYOUT_TEST_RECORD']).write_text(json.dumps(r))\nraise SystemExit(int(os.environ.get('NOMO_TRYOUT_TEST_EXIT','0')))\n")
        script.chmod(0o700)
        self.environment=clean_environment();self.environment['PATH']=str(fake)+os.pathsep+self.environment['PATH']
        self.environment['NOMO_TRYOUT_TEST_RECORD']=str(self.record)

    def launch(self,*args,**updates):
        env=dict(self.environment);env.update(updates)
        return subprocess.run([str(LAUNCH),*map(str,args)],cwd=ROOT,env=env,input=b'',capture_output=True,timeout=10)

    def assert_readonly_overlay(self, record):
        argv=record['argv']; overlays=[argv[index+1] for index,value in enumerate(argv[:-1]) if value=='--file']
        self.assertEqual(overlays[-1],str(ROOT/'config/local-tryout-readonly-compose.yaml'))
        self.assertIn('ETAS_HOST_APPROVAL: "deny"',(ROOT/'config/local-tryout-readonly-compose.yaml').read_text())
        self.assertTrue('--tty=false' in argv or '-T' in argv)

    def test_help_needs_no_directory_or_provider_and_unsets_overrides(self):
        result=self.launch('help',ETAS_HOST_MODEL_BASE_URL='http://invalid.test',ETAS_HOST_MODEL_API_KEY=TOKEN,NOMO_QWEN_SERVER_API_KEY=TOKEN,NOMO_GATEWAY_CLIENT_TOKEN=TOKEN)
        self.assertEqual(result.returncode,0,result.stderr.decode());record=json.loads(self.record.read_text())
        self.assertEqual(record['model_env_keys'],[]);self.assert_readonly_overlay(record)
        self.assertIn('chain_help',record['argv']);self.assertIn('chain-help',record['argv'])
        self.assertNotIn('local-tryout-model-compose.yaml',' '.join(record['argv']))

    def test_show_uses_fixed_mounts_and_provider_free_profile(self):
        self.prepare()
        result=self.launch('show',self.directory,'--id','tryout-1','--workspace','local-tryout','--path','demo/value.txt',NOMO_QWEN_SERVER_API_KEY=TOKEN,ETAS_HOST_MODEL_API_KEY=TOKEN)
        self.assertEqual(result.returncode,0,result.stderr.decode());record=json.loads(self.record.read_text())
        self.assertEqual(record['model_env_keys'],[]);self.assert_readonly_overlay(record)
        self.assertEqual(record['state'],str(self.directory/'state'));self.assertEqual(record['workspace'],str(self.directory/'workspace'));self.assertEqual(record['context'],str(self.directory/'context'))
        self.assertIn('chain_show',record['argv']);self.assertIn('work-chain-show',record['argv'])
        self.assertNotIn('local-tryout-model-compose.yaml',' '.join(record['argv']))

    def test_native_arguments_are_forwarded_without_shell_interpretation(self):
        self.prepare();request="literal $(never-run) ' quoted"
        args=['--id','tryout-1','--workspace','local-tryout','--path','demo/value.txt','--once',request,'--allow','demo/context.txt']
        result=self.launch('new',self.directory,*args,NOMO_QWEN_SERVER_API_KEY=TOKEN)
        self.assertEqual(result.returncode,0,result.stderr.decode());argv=json.loads(self.record.read_text())['argv']
        self.assertEqual(argv[argv.index('--args')+1:],args)
        self.assertIn('chain_new',argv);self.assertIn('work-chain',argv)

    def test_trace_name_validation_and_collision_precede_docker(self):
        self.prepare()
        for name in ['../trace-bad.json','trace-other/name.json','bad.json','trace-'+('x'*60)+'.json']:
            result=self.launch('show',self.directory,NOMO_TRYOUT_TRACE_NAME=name)
            self.assertNotEqual(result.returncode,0,name);self.assertFalse(self.record.exists())
        trace=self.directory/'state/trace-owned.json';trace.write_bytes(b'keep-existing-trace')
        result=self.launch('show',self.directory,NOMO_TRYOUT_TRACE_NAME='trace-owned.json')
        self.assertNotEqual(result.returncode,0);self.assertEqual(trace.read_bytes(),b'keep-existing-trace');self.assertFalse(self.record.exists())

    def test_host_path_controls_refuse_before_preparation_or_docker(self):
        for suffix in ['\n', '\r', '\t']:
            directory=self.parent/('owned'+suffix)
            result=invoke(directory)
            self.assertNotEqual(result.returncode,0);self.assertFalse(directory.exists())
            result=self.launch('show',directory)
            self.assertNotEqual(result.returncode,0);self.assertFalse(self.record.exists())

    def test_docker_exit_is_not_reinterpreted_as_application_success(self):
        result=self.launch('help',NOMO_TRYOUT_TEST_EXIT='37')
        self.assertEqual(result.returncode,37)


if __name__=='__main__':unittest.main()
