#!/usr/bin/env python3
"""Host orchestration checks for durable offline-check intent and completion."""
import contextlib,importlib.util,io,os,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('history_work_launcher',ROOT/'scripts/nomo-history-work.py');launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
class TTY(io.StringIO):
    def isatty(self):return True
class HistoryWorkLauncherTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.context=self.root/'context';self.context.mkdir(mode=0o700)
        self.workspace=self.root/'workspace';self.workspace.mkdir(mode=0o700);(self.workspace/'note.txt').write_text('old')
        self.state=self.root/'state';self.state.mkdir(mode=0o700);(self.state/'.nomo-session.lock').touch(mode=0o600);(self.state/'history.sqlite3').write_bytes(b'synthetic')
        self.project=self.root/'project';self.project.mkdir(mode=0o700);self.project_patch=patch.object(launcher,'ROOT',self.project);self.project_patch.start();self.addCleanup(self.project_patch.stop)
        self.env=patch.dict(os.environ,{'MINIMAX_API_KEY':'SYNTHETIC_KEY','NOMO_ETAS_VERSION':'0.4.1'});self.env.start();self.addCleanup(self.env.stop);self.addCleanup(self.tmp.cleanup)
    def args(self):return ['--read-root',str(self.context),'--root',str(self.workspace),'--state',str(self.state),'--id','id1','--path','note.txt','--allow','context.txt','--once','change it','--check','/bin/true']
    def invoke(self):
        with patch.object(launcher.sys,'stdin',TTY()),contextlib.redirect_stdout(TTY()),contextlib.redirect_stderr(io.StringIO()):return launcher.main(self.args())
    def test_help_lists_session_work_and_its_current_roots(self):
        result=subprocess.run(['bash',str(ROOT/'scripts/nomo-read.sh'),'--help'],capture_output=True,text=True,check=True)
        self.assertIn('session-work --read-root',result.stdout)
        self.assertIn('--root OWNED_DIRECTORY --state PRIVATE_DIRECTORY --id ID',result.stdout)
    def test_fresh_cache_created_before_launch(self):
        self.assertFalse((self.project/'.etas').exists())
        def owned(command,env,**kwargs):
            self.assertTrue((self.project/'.etas').is_dir());return 143
        with patch.object(launcher.edit,'run_owned',side_effect=owned):self.assertEqual(self.invoke(),143)
    def test_cache_symlink_refused_before_launch(self):
        (self.project/'.etas').symlink_to(self.context,target_is_directory=True)
        with patch.object(launcher.edit,'run_owned') as run:
            self.assertNotEqual(self.invoke(),0);run.assert_not_called()

    def test_success_records_check_before_and_after_offline_command(self):
        with patch.object(launcher.edit,'run_owned',side_effect=[0,0,0,0,0]) as run:
            self.assertEqual(self.invoke(),0)
        self.assertEqual(run.call_count,5);work,start,check,finish,output=run.call_args_list
        self.assertIn('--check-ref',work.args[0]);self.assertIn('history_check',start.args[0]);self.assertIn('start',start.args[0]);self.assertIn('finish',finish.args[0]);self.assertIn('passed',finish.args[0])
        for call in (start,check,finish):self.assertNotIn('MINIMAX_API_KEY',call.args[1])
        self.assertFalse(any('nomo-minimax-model-compose.yaml' in p for p in start.args[0]))
    def test_default_026_is_used_for_all_phases(self):
        with patch.dict(os.environ,{},clear=False):
            os.environ.pop('NOMO_ETAS_VERSION',None)
            with patch.object(launcher.edit,'run_owned',side_effect=[0,0,0,0,0]) as run:
                self.assertEqual(self.invoke(),0)
        for call in run.call_args_list:
            self.assertTrue(any('etas-041-official-compose.yaml' in str(part) for part in call.args[0]))
            self.assertEqual(call.args[1]['NOMO_ETAS_VERSION'],'0.4.1')
    def test_older_and_invalid_versions_are_rejected(self):
        for version in ('0.2.3','0.2.4','0.2.5','unsupported'):
            with self.subTest(version=version), patch.dict(os.environ,{'NOMO_ETAS_VERSION':version}), patch.object(launcher.edit,'run_owned') as run:
                self.assertNotEqual(self.invoke(),0);run.assert_not_called()
    def test_uncertain_check_does_not_save_a_result(self):
        with patch.object(launcher.edit,'run_owned',side_effect=[0,0,125]) as run:
            self.assertEqual(self.invoke(),125)
        self.assertEqual(run.call_count,3)
    def test_edit_failure_never_starts_check(self):
        with patch.object(launcher.edit,'run_owned',return_value=143) as run:
            self.assertEqual(self.invoke(),143)
        self.assertEqual(run.call_count,1)
    def test_known_check_failure_is_recorded_with_exit(self):
        with patch.object(launcher.edit,'run_owned',side_effect=[0,0,7,0,0]) as run:
            self.assertEqual(self.invoke(),7)
        self.assertEqual(run.call_count,5);self.assertIn('failed',run.call_args_list[-2].args[0]);self.assertIn('7',run.call_args_list[-2].args[0])
    def test_timeout_leaves_check_uncertain(self):
        with patch.object(launcher.edit,'run_owned',side_effect=[0,0,124]) as run:
            self.assertEqual(self.invoke(),124)
        self.assertEqual(run.call_count,3)

    def test_uncertain_independent_check_shows_only_complete_filtered_diagnostics(self):
        policy=self.root/'policy';policy.mkdir(mode=0o700)
        args=['--independent-check','--root',str(self.workspace),'--state',str(self.state),'--id','check-id',
              '--events-policy-dir',str(policy),'--check','missing-tool']
        for code,truncated,visible in ((127,False,True),(127,True,False),(125,False,False)):
            output=TTY();error=io.StringIO()
            def owned(command,env,capture=None,**kwargs):
                capture['stderr']['data'].extend(b'Cannot execute SYNTHETIC_SECRET SYNTHETIC_KEY')
                capture['stderr']['truncated']=truncated
                return code
            with patch.object(launcher.policy_module,'read_private',return_value=(policy,b'{"literals":["SYNTHETIC_SECRET"]}','binding')), \
                 patch.object(launcher.sys,'stdin',TTY()),contextlib.redirect_stdout(output),contextlib.redirect_stderr(error), \
                 patch.object(launcher.edit,'run_owned',side_effect=owned) as run:
                self.assertEqual(launcher.main(args),code)
            self.assertEqual(run.call_count,1)
            self.assertEqual('Cannot execute' in output.getvalue(),visible)
            self.assertNotIn('SYNTHETIC_SECRET',output.getvalue());self.assertNotIn('SYNTHETIC_KEY',output.getvalue())
            self.assertIn('no result was recorded',error.getvalue())
if __name__=='__main__':unittest.main()
