import importlib.util,io,json,sqlite3,tempfile,types,unittest
from pathlib import Path
p=Path(__file__).with_name('b08_synthetic_probe.py');spec=importlib.util.spec_from_file_location('b08',p);probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)

class HandlerTests(unittest.TestCase):
 def call(self,phase,server):
  body=json.dumps({'messages':[{'role':'system','content':''},{'role':'user','content':json.dumps({'phase':phase,'request':probe.PROMPT,'before':probe.BEFORE})}]}).encode()
  h=object.__new__(probe.Provider);h.path='/v1/chat/completions';h.headers={'Content-Length':str(len(body)),'Authorization':'Bearer '+probe.TOKEN};h.rfile=io.BytesIO(body);h.wfile=io.BytesIO();h.server=server;codes=[]
  h.send_response=lambda code:codes.append(code);h.send_header=lambda *a:None;h.end_headers=lambda:None;h.send_error=lambda code:codes.append(code)
  h.do_POST();return codes,h.wfile.getvalue()
 def test_synthetic_plan_and_edit(self):
  server=types.SimpleNamespace(phases=[],failure=None)
  code,body=self.call('plan',server);self.assertEqual([200],code);self.assertEqual('delegate',json.loads(json.loads(body)['choices'][0]['message']['content'])[0])
  code,body=self.call('child',server);self.assertEqual([200],code);self.assertEqual(['edit','timeout_seconds = 30','timeout_seconds = 45'],json.loads(json.loads(body)['choices'][0]['message']['content']))
  self.assertEqual(['plan','child'],server.phases)
 def test_unexpected_phase_fails(self):
  server=types.SimpleNamespace(phases=[],failure=None);code,_=self.call('child',server);self.assertEqual([500],code);self.assertEqual([],server.phases)
 def test_journal_count_from_readonly_copy(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);state=root/'state';state.mkdir();self.assertEqual('absent',probe.journal_state(state,root/'absent')['database'])
   with sqlite3.connect(state/'edit.sqlite3') as c:
    c.execute('create table memory_entries(region text)');c.execute('insert into memory_entries values (?)',('nomo-edit-operation-v1',))
   result=probe.journal_state(state,root/'copy');self.assertTrue(result['integrity_ok']);self.assertEqual(1,result['operation_entries'])
if __name__=='__main__':unittest.main()
