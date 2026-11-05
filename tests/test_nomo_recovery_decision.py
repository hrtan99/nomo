#!/usr/bin/env python3
import contextlib,importlib.util,io,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('recovery_launcher',ROOT/'scripts/nomo-history-work.py');launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
class TTY(io.StringIO):
 def isatty(self):return True
class RecoveryDecisionTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.state=self.root/'state';self.state.mkdir(mode=0o700);(self.state/'.nomo-session.lock').touch(mode=0o600);(self.state/'history.sqlite3').write_bytes(b'fixture');self.project=self.root/'project';self.project.mkdir(mode=0o700)
  self.root_patch=patch.object(launcher,'ROOT',self.project);self.root_patch.start();self.addCleanup(self.root_patch.stop)
  self.env=patch.dict(os.environ,{'MINIMAX_API_KEY':'SYNTHETIC_KEY','NOMO_QWEN_SERVER_API_KEY':'SYNTHETIC_OTHER'});self.env.start();self.addCleanup(self.env.stop)
 def invoke(self,answer,target="work"):
  out=TTY();err=io.StringIO()
  with patch.object(launcher.sys,'stdin',TTY()),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err),patch('builtins.input',return_value=answer):code=launcher.recovery_decision(['--state',str(self.state),'--id','op1','--target',target])
  return code,out.getvalue(),err.getvalue()
 def test_yes_records_after_status_with_no_key(self):
  with patch.object(launcher.edit,'run_owned',side_effect=[0,0]) as run:
   code,out,_=self.invoke('yes');self.assertEqual(code,0);self.assertIn('no rollback or retry',out);self.assertEqual(run.call_count,2)
   for call in run.call_args_list:self.assertNotIn('MINIMAX_API_KEY',call.args[1]);self.assertNotIn('NOMO_QWEN_SERVER_API_KEY',call.args[1])
   self.assertIn('read_session_status',run.call_args_list[0].args[0]);self.assertIn('recovery_decision',run.call_args_list[1].args[0])
 def test_followup_targets_are_forwarded_without_keys(self):
  for target in ('followup','followup-check'):
   with patch.object(launcher.edit,'run_owned',side_effect=[0,0]) as run:
    code,out,_=self.invoke('yes',target);self.assertEqual(code,0);self.assertIn('Abandon '+target,out)
    self.assertIn(target,run.call_args_list[1].args[0]);self.assertNotIn('MINIMAX_API_KEY',run.call_args_list[1].args[1])
 def test_no_does_not_write(self):
  with patch.object(launcher.edit,'run_owned',return_value=0) as run:
   code,out,_=self.invoke('n');self.assertNotEqual(code,0);self.assertIn('No decision recorded',out);self.assertEqual(run.call_count,1)
 def test_status_failure_does_not_prompt_or_write(self):
  with patch.object(launcher.edit,'run_owned',return_value=125) as run:
   code,_,_=self.invoke('yes');self.assertNotEqual(code,0);self.assertEqual(run.call_count,1)
 def test_non_tty_refuses_before_launch(self):
  with patch.object(launcher.sys,'stdin',io.StringIO()),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()),patch.object(launcher.edit,'run_owned') as run:
   self.assertNotEqual(launcher.recovery_decision(['--state',str(self.state),'--id','op1','--target','work']),0);run.assert_not_called()
 def test_symlink_database_refuses(self):
  (self.state/'history.sqlite3').unlink();(self.state/'history.sqlite3').symlink_to(self.root/'other')
  with patch.object(launcher.edit,'run_owned') as run:self.assertNotEqual(self.invoke('yes')[0],0);run.assert_not_called()
if __name__=='__main__':unittest.main()
