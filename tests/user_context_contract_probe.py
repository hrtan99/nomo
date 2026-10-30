#!/usr/bin/env python3
"""Synthetic pure user-context selection and consent argument checks."""
import argparse,json,shutil,subprocess,tempfile
from pathlib import Path
from normal_graph_identity import verify_cli
from harness_checkpoint_contract_probe import MANIFEST
ROOT=Path(__file__).resolve().parent.parent

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True);opts=parser.parse_args()
 opts.evidence_dir.mkdir(parents=True,exist_ok=True);evidence=Path(tempfile.mkdtemp(prefix='user-context-contract-',dir=opts.evidence_dir));project=evidence/'project';project.mkdir()
 shutil.copytree(ROOT/'src',project/'src');(project/'src/app').mkdir();shutil.copyfile(ROOT/'tests/fixtures/user_context001/contract_probe.es',project/'src/app/contract_probe.es');(project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','user-context-contract-probe'))
 result={'status':'failed','scope':'pure argument selection; no Model, Memory, Fs, Approval or user files','commands':[]}
 try:
  cli=verify_cli()
  for name,args in [('check',[cli,'check','--all',project]),('effects',[cli,'effects',project,'--flow','pure_probe']),('observe',[cli,'run',project,'--flow','observe','--allow-effects']),('old-ledger',[cli,'run',project,'--flow','old_ledger','--allow-effects']),('user-ledger',[cli,'run',project,'--flow','user_ledger','--allow-effects']),('old-outcome',[cli,'run',project,'--flow','old_outcome','--allow-effects']),('user-outcome',[cli,'run',project,'--flow','user_outcome','--allow-effects'])]:
   p=subprocess.run(list(map(str,args)),capture_output=True,timeout=240);(evidence/(name+'.stdout.bin')).write_bytes(p.stdout);(evidence/(name+'.stderr.bin')).write_bytes(p.stderr);result['commands'].append({'name':name,'exit':p.returncode,'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace')});assert p.returncode==0 and not p.stderr
   if name=='effects':assert b'requested actions: []' in p.stdout and b'default actions: []' in p.stdout
   if name=='observe':assert p.stdout==b'PASS user-context selection and consent options\n'
   prefix=b'LEDGER work steps=0/13 calls=0/7 generation_allowance=0/47104 native_token_ceiling=0/196608; per-turn configured allowances are not measured usage; '
   if name=='old-ledger':assert p.stdout==prefix+b'bounded v2 continuation requires a fresh durable claim and current confirmation\n'
   if name=='user-ledger':assert p.stdout==prefix+b'user-context work cannot continue or resume\n'
   suffix=b'\nNEXT help (run from the project root):\n./scripts/local-tryout.sh help\n'
   if name=='old-outcome':assert p.stdout==b'REFUSED same diagnostic\n'+prefix+b'bounded v2 continuation requires a fresh durable claim and current confirmation'+suffix
   if name=='user-outcome':assert p.stdout==b'REFUSED same diagnostic\n'+prefix+b'user-context work cannot continue or resume'+suffix
  result['status']='passed'
 finally:
  (evidence/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 print('PASS user-context selection contract',evidence)
if __name__=='__main__':main()
