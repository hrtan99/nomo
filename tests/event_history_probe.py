#!/usr/bin/env python3
"""Synthetic known-literal ordered event store across independent processes."""
import argparse,hashlib,json,shutil,sqlite3,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
MANIFEST='''[package]
name = "event-history-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "event-history-probe"
[runtime.profiles.fixture.memory]
backend = "sqlite"
path = "history.sqlite3"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow", "memory=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.event_history_probe"
flow = "event_history_probe"
profile = "fixture"
'''
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--etas',type=Path,required=True);parser.add_argument('--sha256',required=True);parser.add_argument('--evidence-dir',type=Path,required=True);args=parser.parse_args()
 assert args.etas.is_absolute() and digest(args.etas)==args.sha256
 out=Path(tempfile.mkdtemp(prefix='event-history-',dir=args.evidence_dir));project=out/'project';project.mkdir();shutil.copytree(ROOT/'src',project/'src');(project/'src/app').mkdir();shutil.copyfile(ROOT/'tests/fixtures/event_history/probe.es',project/'src/app/event_history_probe.es');(project/'etas.toml').write_text(MANIFEST)
 result={'status':'failed','scope':'known-literal synthetic events; isolated store, no production integration','phases':[]}
 try:
  checked=subprocess.run([str(args.etas),'check','--all',str(project)],capture_output=True,cwd=out,timeout=120);assert checked.returncode==0 and not checked.stderr
  for phase in ('first','repeat','second','inspect'):
   run=subprocess.run([str(args.etas),'run',str(project),'--flow','event_history_probe','--allow-effects','--args',phase],capture_output=True,cwd=out,timeout=120)
   (out/(phase+'.stdout')).write_bytes(run.stdout);(out/(phase+'.stderr')).write_bytes(run.stderr)
   result['phases'].append({'phase':phase,'exit':run.returncode});assert run.returncode==0 and not run.stderr and ('PASS '+phase+'\n').encode() in run.stdout
  db=out/'history.sqlite3'
  with sqlite3.connect(db) as c:
   assert c.execute('pragma integrity_check').fetchone()==('ok',);rows=c.execute("select value_json from memory_entries where region='nomo-event-history-v1'").fetchall();assert len(rows)==1
   payload=rows[0][0];assert 'VERY_SECRET_123' not in payload and 'ANOTHER_TOKEN_456' not in payload and payload.count('[REDACTED]')==3
  for p in out.glob('history.sqlite3*'):
   assert b'VERY_SECRET_123' not in p.read_bytes() and b'ANOTHER_TOKEN_456' not in p.read_bytes()
  assert digest(args.etas)==args.sha256;result['status']='passed'
 except BaseException as e:result['failure_type']=type(e).__name__
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
