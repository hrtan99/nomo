import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

p=Path(__file__).with_name('runner.py');s=importlib.util.spec_from_file_location('runner',p);r=importlib.util.module_from_spec(s);s.loader.exec_module(r)

class RunnerTests(unittest.TestCase):
 def test_prepares_every_exact_fixture_and_b05_failure(self):
  for task in r.fixture.TASKS:
   with self.subTest(task=task),tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp)/'run';result=r.prepare(task,root)
    self.assertEqual('not_run',result['benchmark_status']);self.assertFalse(result['product_launched']);self.assertEqual(0,result['baseline_exit'])
    self.assertEqual(r.PROMPTS[task],result['prompts']);self.assertEqual(r.fixture.snapshot(root/'workspace'),r.fixture.expected_snapshot(r.fixture.files_for(task)))
    self.assertEqual(task=='B05',result['b05_initial_exit'] not in (None,0))
    self.assertEqual(json.loads((root/'preparation.json').read_text()),result)
    with self.assertRaises(FileExistsError):r.prepare(task,root)
 def test_independent_tree_inspection_rejects_overbroad_changes(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)/'run';r.prepare('B03',root)
   good,path=r.inspect_prepared(root);self.assertTrue(good['checks']['workspace_change_scope']);self.assertEqual('not_run',good['benchmark_status']);self.assertTrue(path.exists())
   (root/'workspace/README.md').write_text('changed')
   bad,path2=r.inspect_prepared(root);self.assertFalse(bad['checks']['workspace_change_scope']);self.assertNotEqual(path,path2);self.assertTrue(path.exists())
   manifest=root/'preparation.json';value=json.loads(manifest.read_text());value['workspace_initial']={};manifest.write_text(json.dumps(value))
   with self.assertRaises(ValueError):r.inspect_prepared(root)
 def test_simulations_never_count(self):
  rows=[{'task':'B01','slot':i,'run_id':str(i),'kind':'simulation','assertions':{k:True for k in r.ASSERTIONS['B01']}} for i in (1,2,3)]
  result=r.provisional_score(rows);self.assertEqual(0,result['consistent_claims']);self.assertEqual('not_run',result['tasks']['B01']['status']);self.assertEqual('not_verified',result['release_benchmark_status'])
 def make(self,slot,task='B01'):
  return {'task':task,'slot':slot,'run_id':task+'-'+str(slot),'kind':'real','action_started':True,'evidence_ref':'independent/fixture','reviewer':'QA-REL','product_revision':'rev','etas_version':'0.2.5','provider_model':'observed-model','assertions':{k:True for k in r.ASSERTIONS[task]}}
 def test_three_consistent_claims_are_only_provisional(self):
  rows=[self.make(i) for i in (1,2,3)];x=r.provisional_score(rows)
  self.assertEqual('provisional_consistent',x['tasks']['B01']['status']);self.assertEqual(1,x['consistent_claims']);self.assertEqual('not_verified',x['release_benchmark_status']);self.assertEqual('not_evaluated',x['threshold_status'])
  rows[1]['assertions']['workspace_unchanged']=False;x=r.provisional_score(rows);self.assertEqual('provisional_fail',x['tasks']['B01']['status']);self.assertEqual(0,x['consistent_claims'])
 def test_missing_assertion_duplicate_and_wrong_types_fail_closed(self):
  row=self.make(1);del row['assertions']['workspace_unchanged']
  with self.assertRaises(ValueError):r.provisional_score([row])
  row=self.make(1);row['assertions']['workspace_unchanged']=1
  with self.assertRaises(ValueError):r.provisional_score([row])
  with self.assertRaises(ValueError):r.provisional_score([self.make(1),self.make(1)])
  row=self.make(1);row['action_started']=False
  with self.assertRaises(ValueError):r.provisional_score([row])
 def test_invalid_infrastructure_repeat_is_limited_and_no_hidden_retry(self):
  invalid={'task':'B01','slot':1,'run_id':'invalid','kind':'infra_invalid','action_started':False,'evidence_ref':'fixture/observation'}
  row=self.make(1);x=r.provisional_score([invalid,row]);self.assertEqual('incomplete',x['tasks']['B01']['status'])
  with self.assertRaises(ValueError):r.provisional_score([row,invalid])
  invalid2=dict(invalid,run_id='invalid2')
  with self.assertRaises(ValueError):r.provisional_score([invalid,invalid2,row])
  invalid['action_started']=True
  with self.assertRaises(ValueError):r.provisional_score([invalid])
 def test_pre_action_product_failure_is_not_ignored(self):
  row=self.make(1);row['action_started']=False;row['assertions']['answer_value_path']=False
  self.assertEqual('provisional_fail',r.provisional_score([row])['tasks']['B01']['status'])
if __name__=='__main__':unittest.main()
