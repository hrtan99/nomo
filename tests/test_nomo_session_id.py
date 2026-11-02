#!/usr/bin/env python3
import contextlib,importlib.util,io,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('session_id',ROOT/'scripts/nomo-session-id.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class SessionIDTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name).resolve();self.identifier='1'*32
 def call(self,args):
  out=io.StringIO();err=io.StringIO()
  with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):code=module.main(args)
  return code,out.getvalue(),err.getvalue()
 def test_start_and_resume_same_state(self):
  start=['start','--sessions-dir',str(self.base),'--root','/root','--allow','context.txt','--once','question']
  with patch.object(module.secrets,'token_hex',return_value=self.identifier),patch.object(module._edit,'run_owned',return_value=0) as call:
   code,out,_=self.call(start);self.assertEqual(code,0);self.assertIn('SESSION ID '+self.identifier,out);self.assertIn('Resume: nomo-read.sh session-id resume',out);self.assertTrue((self.base/self.identifier).is_dir());self.assertIn(str(self.base/self.identifier),call.call_args.args[0])
   code,out,_=self.call(['resume','--sessions-dir',str(self.base),'--id',self.identifier,'--root','/root2','--allow','context.txt','--once','again']);self.assertEqual(code,0);self.assertIn('newly selected',out);self.assertIn(str(self.base/self.identifier),call.call_args.args[0])
 def test_status_and_failure_retains_state(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  with patch.object(module._edit,'run_owned',return_value=125):
   code,out,err=self.call(['status','--sessions-dir',str(self.base),'--id',self.identifier]);self.assertEqual(code,125);self.assertIn('retained',err);self.assertTrue((self.base/self.identifier).is_dir())
 def test_work_uses_session_and_distinct_operation_id(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  args=['work','--sessions-dir',str(self.base),'--id',self.identifier,'--read-root','/read','--root','/edit','--operation-id','op1','--path','note.txt','--allow','context.txt','--once','change','--check','/bin/true']
  with patch.object(module._edit,'run_owned',return_value=0) as launch:
   code,out,_=self.call(args);self.assertEqual(code,0);cmd=launch.call_args.args[0];self.assertTrue(any(str(x).endswith('nomo-history-work.py') for x in cmd));self.assertIn(str(self.base/self.identifier),cmd);self.assertEqual(cmd[cmd.index('--id')+1],'op1');self.assertEqual(cmd[-2:],['--check','/bin/true']);self.assertIn('SESSION ID '+self.identifier,out)
 def test_work_missing_options_and_empty_check_refused(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  with patch.object(module._edit,'run_owned') as launch:
   self.assertNotEqual(self.call(['work','--sessions-dir',str(self.base),'--id',self.identifier])[0],0)
   args=['work','--sessions-dir',str(self.base),'--id',self.identifier,'--read-root','/read','--root','/edit','--operation-id','op1','--path','note.txt','--allow','context.txt','--once','change','--check']
   self.assertNotEqual(self.call(args)[0],0);launch.assert_not_called()
 def test_decision_routes_selected_state_and_operation(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  args=['decision','--sessions-dir',str(self.base),'--id',self.identifier,'--operation-id','op1','--target','work']
  with patch.object(module._edit,'run_owned',return_value=0) as launch:
   code,_,_=self.call(args);self.assertEqual(code,0);cmd=launch.call_args.args[0];self.assertTrue(any(str(x).endswith('nomo-recovery-decision.py') for x in cmd));self.assertIn(str(self.base/self.identifier),cmd);self.assertEqual(cmd[-4:],['--id','op1','--target','work'])
 def test_invalid_id_and_latest_fail_without_launch(self):
  with patch.object(module._edit,'run_owned') as launch:
   for value in ('../x','latest','A'*32,'0'*31):
    code,_,err=self.call(['status','--sessions-dir',str(self.base),'--id',value]);self.assertNotEqual(code,0);self.assertIn('REFUSED',err)
   launch.assert_not_called()
 def test_registry_and_session_symlinks_refused(self):
  link=self.base/'link';link.symlink_to(self.base,target_is_directory=True)
  with patch.object(module._edit,'run_owned') as launch:
   self.assertNotEqual(self.call(['status','--sessions-dir',str(link),'--id',self.identifier])[0],0)
   (self.base/self.identifier).symlink_to(self.base,target_is_directory=True)
   self.assertNotEqual(self.call(['status','--sessions-dir',str(self.base),'--id',self.identifier])[0],0);launch.assert_not_called()
 def test_permissions_and_collision_fail_closed(self):
  self.base.chmod(0o755)
  with patch.object(module._edit,'run_owned') as launch:self.assertNotEqual(self.call(['status','--sessions-dir',str(self.base),'--id',self.identifier])[0],0);launch.assert_not_called()
  self.base.chmod(0o700);(self.base/self.identifier).mkdir(mode=0o700)
  with patch.object(module.secrets,'token_hex',return_value=self.identifier),patch.object(module._edit,'run_owned') as launch:
   self.assertNotEqual(self.call(['start','--sessions-dir',str(self.base),'--root','/root','--allow','f','--once','q'])[0],0);launch.assert_not_called()
if __name__=='__main__':unittest.main()
