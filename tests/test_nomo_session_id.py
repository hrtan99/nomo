#!/usr/bin/env python3
import contextlib,importlib.util,io,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('session_id',ROOT/'scripts/nomo-session-id.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class SessionIDTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name).resolve();self.identifier='1'*32
  self.workspace=self.base/'workspace';self.workspace.mkdir(mode=0o700)
 def call(self,args):
  out=io.StringIO();err=io.StringIO()
  with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):code=module.main(args)
  return code,out.getvalue(),err.getvalue()
 def test_start_and_resume_same_state(self):
  start=['start','--sessions-dir',str(self.base),'--root',str(self.workspace),'--allow','context.txt','--once','question']
  with patch.object(module.secrets,'token_hex',return_value=self.identifier),patch.object(module._edit,'run_owned',return_value=0) as call:
   code,out,_=self.call(start);self.assertEqual(code,0);self.assertIn('SESSION ID '+self.identifier,out);self.assertIn('Resume: nomo-read.sh session-id resume',out);self.assertTrue((self.base/self.identifier).is_dir());self.assertIn(str(self.base/self.identifier),call.call_args.args[0])
   code,out,_=self.call(['resume','--sessions-dir',str(self.base),'--id',self.identifier,'--root',str(self.workspace),'--allow','context.txt','--once','again']);self.assertEqual(code,0);self.assertIn('Workspace binding recorded and verified',out);self.assertIn(str(self.base/self.identifier),call.call_args.args[0])
  other=self.base/'other';other.mkdir()
  with patch.object(module._edit,'run_owned') as call:
   code,_,err=self.call(['resume','--sessions-dir',str(self.base),'--id',self.identifier,'--root',str(other),'--allow','context.txt','--once','again']);self.assertNotEqual(code,0);self.assertIn('different workspace',err);call.assert_not_called()
 def test_latest_uses_most_recent_compatible_physical_workspace(self):
  identity=module.workspace_identity(str(self.workspace))
  def candidate(identifier,used,graph=b'latest041\n',workspace=None):
   state=self.base/identifier;state.mkdir(mode=0o700)
   with patch.object(module.secrets,'token_hex',return_value='f'*32),patch.object(module.time,'time_ns',return_value=used):module.bind_workspace(state,workspace or identity)
   lock=state/'.nomo-session.lock';lock.write_bytes(graph);lock.chmod(0o600)
   history=state/'history.sqlite3';history.write_bytes(b'sqlite');history.chmod(0o600)
  candidate('2'*32,20);candidate('3'*32,30);candidate('4'*32,40,b'future\n')
  other=self.base/'other-latest';other.mkdir();candidate('5'*32,50,workspace=module.workspace_identity(str(other)))
  with patch.object(module,'probe_session',side_effect=lambda state,policy:state.name=='2'*32),patch.object(module._edit,'run_owned',return_value=0) as launch:
   code,out,_=self.call(['resume','--sessions-dir',str(self.base),'--id','latest','--root',str(self.workspace),'--allow','f','--once','q'])
  self.assertEqual(code,0);self.assertIn('SESSION ID '+'2'*32,out);self.assertIn(str(self.base/('2'*32)),launch.call_args.args[0])
 def test_runtime_probe_controls_recoverability_without_model_credentials(self):
  state=self.base/'probe';state.mkdir()
  def result(code,output=b'',truncated=False):
   def run(command,env,capture,**kwargs):
    capture['stdout']={'data':bytearray(output),'truncated':truncated}
    self.assertNotIn('MINIMAX_API_KEY',env);self.assertIn('status',command)
    return code
   return run
  with patch.dict(os.environ,{'MINIMAX_API_KEY':'secret'}),patch.object(module._edit,'run_owned',side_effect=result(0)):
   self.assertTrue(module.probe_session(state,'/policy'))
  with patch.object(module._edit,'run_owned',side_effect=result(1)):
   self.assertFalse(module.probe_session(state,None))
  for run in (result(125),result(1,b'REFUSED session already in use\n'),result(0,truncated=True)):
   with self.subTest(run=run),patch.object(module._edit,'run_owned',side_effect=run),self.assertRaises(ValueError):module.probe_session(state,None)
 def test_replaced_workspace_at_same_path_is_not_the_bound_workspace(self):
  state=self.base/self.identifier;state.mkdir(mode=0o700)
  with patch.object(module.secrets,'token_hex',return_value='e'*32):module.bind_workspace(state,module.workspace_identity(str(self.workspace)))
  old=self.base/'workspace-old';self.workspace.rename(old);self.workspace.mkdir(mode=0o700)
  with patch.object(module._edit,'run_owned') as launch:
   code,_,err=self.call(['resume','--sessions-dir',str(self.base),'--id',self.identifier,'--root',str(self.workspace),'--allow','f','--once','q'])
  self.assertNotEqual(code,0);self.assertIn('different workspace',err);launch.assert_not_called()
 def test_init_creates_random_session_without_question_or_workspace(self):
  args=['init','--sessions-dir',str(self.base),'--events-policy-dir','/policy']
  with patch.object(module.secrets,'token_hex',return_value=self.identifier),patch.object(module._edit,'run_owned',return_value=0) as launch:
   code,out,_=self.call(args);self.assertEqual(code,0);self.assertIn('SESSION ID '+self.identifier,out)
   command=launch.call_args.args[0];self.assertIn('init',command);self.assertIn(str(self.base/self.identifier),command)
   self.assertNotIn('--once',command);self.assertNotIn('--root',command);self.assertTrue((self.base/self.identifier).is_dir())
 def test_status_and_failure_retains_state(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  with patch.object(module._edit,'run_owned',return_value=125):
   code,out,err=self.call(['status','--sessions-dir',str(self.base),'--id',self.identifier]);self.assertEqual(code,125);self.assertIn('retained',err);self.assertTrue((self.base/self.identifier).is_dir())
 def test_work_uses_session_and_distinct_operation_id(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  args=['work','--sessions-dir',str(self.base),'--id',self.identifier,'--read-root','/read','--root','/edit','--operation-id','op1','--path','note.txt','--allow','context.txt','--once','change','--check','/bin/true']
  with patch.object(module._edit,'run_owned',return_value=0) as launch:
   code,out,_=self.call(args);self.assertEqual(code,0);cmd=launch.call_args.args[0];self.assertTrue(any(str(x).endswith('nomo-history-work.py') for x in cmd));self.assertIn(str(self.base/self.identifier),cmd);self.assertIn('--id=op1',cmd);self.assertEqual(cmd[-2:],['--check','/bin/true']);self.assertIn('SESSION ID '+self.identifier,out)
 def test_event_work_forwards_policy_before_check(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  args=['work','--sessions-dir',str(self.base),'--id',self.identifier,'--read-root','/read','--root','/edit','--operation-id','op1','--path','note.txt','--allow','context.txt','--once','change','--events-policy-dir','/policy']
  with patch.object(module._edit,'run_owned',return_value=0) as launch:
   self.assertEqual(self.call(args)[0],0);self.assertEqual(launch.call_args.args[0][-2:],['--events-policy-dir','/policy'])
   launch.reset_mock();self.assertEqual(self.call(args+['--check','true'])[0],0);self.assertEqual(launch.call_args.args[0][-4:],['--events-policy-dir','/policy','--check','true'])
 def test_outputs_is_only_forwarded_for_status(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  with patch.object(module._edit,'run_owned',return_value=0) as launch:
   code,_,_=self.call(['status','--sessions-dir',str(self.base),'--id',self.identifier,'--outputs']);self.assertEqual(code,0);self.assertIn('--outputs',launch.call_args.args[0])
   launch.reset_mock();code,_,_=self.call(['resume','--sessions-dir',str(self.base),'--id',self.identifier,'--root','/root','--allow','x','--once','q','--outputs']);self.assertNotEqual(code,0);launch.assert_not_called()
 def test_events_requires_policy_and_is_only_forwarded_for_status(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  with patch.object(module._edit,'run_owned',return_value=0) as launch:
   args=['status','--sessions-dir',str(self.base),'--id',self.identifier,'--events']
   self.assertNotEqual(self.call(args)[0],0);launch.assert_not_called()
   self.assertEqual(self.call(args+['--events-policy-dir','/policy'])[0],0);self.assertIn('--events',launch.call_args.args[0])
   launch.reset_mock();self.assertNotEqual(self.call(args+['--events-policy-dir','/policy','--outputs'])[0],0);launch.assert_not_called()
 def test_followup_routes_to_separate_launcher(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  args=['followup','--sessions-dir',str(self.base),'--id',self.identifier,'--read-root','/read','--root','/edit','--operation-id','op2','--path','note.txt','--allow','context.txt','--once','change again','--check','/bin/true']
  with patch.object(module._edit,'run_owned',return_value=0) as launch:
   code,out,_=self.call(args);self.assertEqual(code,0);cmd=launch.call_args.args[0];self.assertTrue(any(str(x).endswith('nomo-history-work.py') for x in cmd));self.assertIn('--followup',cmd);self.assertIn(str(self.base/self.identifier),cmd);self.assertIn('--id=op2',cmd);self.assertEqual(cmd[-2:],['--check','/bin/true']);self.assertIn('newly selected',out)
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
   code,_,_=self.call(args);self.assertEqual(code,0);cmd=launch.call_args.args[0];self.assertTrue(any(str(x).endswith('nomo-history-work.py') for x in cmd));self.assertIn('--recovery-decision',cmd);self.assertIn(str(self.base/self.identifier),cmd);self.assertEqual(cmd[-3:],['--id=op1','--target','work'])
 def test_followup_decisions_route_by_operation(self):
  (self.base/self.identifier).mkdir(mode=0o700)
  for target in ('followup','followup-check'):
   args=['decision','--sessions-dir',str(self.base),'--id',self.identifier,'--operation-id','op2','--target',target]
   with patch.object(module._edit,'run_owned',return_value=0) as launch:
    code,_,_=self.call(args);self.assertEqual(code,0);cmd=launch.call_args.args[0];self.assertIn('--id=op2',cmd);self.assertEqual(cmd[-2:],['--target',target])
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
