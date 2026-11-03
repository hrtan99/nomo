import contextlib,importlib.util,io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('read_session_display',ROOT/'scripts/nomo-read-session.py');launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)

def event(role,kind,name,text):return {'role':role,'kind':kind,'name':name,'text':json.dumps(text,ensure_ascii=True)}
def raw_view(**updates):
 view={'encoding':'json-string-v1','events':[event('user','request','','line\n\x1b[2J')], 'work_events':[event('tool','result','read','green')], 'followup_events':[event('assistant','answer','','done')]};view.update(updates)
 return b'other status\nEVENT VIEW '+json.dumps(view,ensure_ascii=True).encode()+b'\n'
class EventDisplayTest(unittest.TestCase):
 def test_group_order_and_terminal_controls_are_escaped(self):
  result=launcher.event_lines(raw_view());self.assertEqual([line.split()[0] for line in result],['CHAT','WORK','FOLLOWUP']);self.assertIn(r'\u001b',result[0]);self.assertIn(r'\n',result[0]);self.assertNotIn('\x1b',result[0]);self.assertIn('green',result[1]);self.assertIn('done',result[2])
 def test_rejects_missing_ambiguous_invalid_or_oversized_batches(self):
  for raw in (b'',raw_view()+raw_view(),raw_view(encoding='unknown'),raw_view(events=[{'role':'a','kind':'b','name':'c','text':'not-json'}]),raw_view(events=[event('a','b','c','x')]*49)):
   with self.assertRaises(ValueError):launcher.event_lines(raw)
 def test_status_events_is_offline_bounded_and_suppresses_raw_view(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp).resolve();state=root/'state';state.mkdir(mode=0o700);(state/'.nomo-session.lock').touch(mode=0o600);(state/'history.sqlite3').write_bytes(b'synthetic');policy=root/'policy';policy.mkdir(mode=0o700);(policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');(policy/'policy.json').chmod(0o600);(policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600);project=root/'project';project.mkdir(mode=0o700)
   def owned(command,env,capture,**kwargs):
    self.assertIn('recoverable_read_status',command);self.assertNotIn('MINIMAX_API_KEY',env);self.assertEqual(kwargs['capture_limit'],4194304);self.assertFalse(kwargs['forward_output']);capture['stdout']={'data':bytearray(raw_view()),'truncated':False};capture['stderr']={'data':bytearray(),'truncated':False};return 0
   out=io.StringIO()
   with patch.object(launcher,'ROOT',project),patch.object(launcher,'run_owned',side_effect=owned),patch.dict(os.environ,{'MINIMAX_API_KEY':'SYNTHETIC_KEY'}),contextlib.redirect_stdout(out),contextlib.redirect_stderr(io.StringIO()):
    code=launcher.main(['status','--state',str(state),'--events','--events-policy-dir',str(policy)])
   self.assertEqual(code,0);self.assertIn('CHAT 1',out.getvalue());self.assertNotIn('EVENT VIEW {',out.getvalue());self.assertNotIn('\x1b',out.getvalue())
if __name__=='__main__':unittest.main()
