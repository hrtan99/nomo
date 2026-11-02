#!/usr/bin/env python3
"""Exercise abandon decisions on copies of previously retained synthetic fixtures."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,tempfile,termios,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
FIXTURES={'followup':Path('/private/tmp/nomo-history-work-qnto06_3/state/history.sqlite3'), 'followup-check':Path('/private/tmp/nomo-history-work-x0fuyhhn/state/history.sqlite3')}
def main():
 out=Path(tempfile.mkdtemp(prefix='nomo-followup-recovery-',dir='/private/tmp'));project=out/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','__pycache__'));env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME']};proc=None;master=None
 try:
  for target,source in FIXTURES.items():
   assert source.is_file();state=out/target;state.mkdir(mode=0o700);(state/'.nomo-session.lock').touch(mode=0o600)
   with sqlite3.connect(source) as src,sqlite3.connect(state/'history.sqlite3') as dst:src.backup(dst)
   if target=='followup-check':
    with sqlite3.connect(state/'history.sqlite3') as c:
     raw=c.execute("select value_json from memory_entries where region='nomo-followup-check-v1'").fetchone()[0];obj=json.loads(raw)
     for field in obj['fields']:
      if field['name']=='phase':field['value']['value']='running'
      if field['name'] in ('outcome','exit_code'):field['value']['value']=''
     c.execute("update memory_entries set value_json=? where region='nomo-followup-check-v1'",(json.dumps(obj,separators=(',',':')),))
   def rows():
    with sqlite3.connect(state/'history.sqlite3') as c:
     assert c.execute('pragma integrity_check').fetchone()==('ok',)
     return c.execute("select region,path,key_json,value_json,version from memory_entries where region!='nomo-recovery-decision-v1' order by region,path,key_json").fetchall()
   before=rows()
   def decide(identifier,answer):
    nonlocal proc,master
    master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
    cmd=[str(project/'scripts/nomo-read.sh'),'session-decision','--state',str(state),'--id',identifier,'--target',target]
    proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);output=bytearray();sent=False;deadline=time.monotonic()+120
    while proc.poll() is None:
     if time.monotonic()>deadline:raise TimeoutError()
     if select.select([master],[],[],.1)[0]:
      try:output.extend(os.read(master,65536))
      except OSError:pass
     if not sent and b'Record abandon? [y/N]' in output:os.write(master,answer+b'\n');sent=True
    while select.select([master],[],[],0)[0]:
     try:data=os.read(master,65536)
     except OSError:break
     if not data:break
     output.extend(data)
    os.close(master);master=None;assert sent;return proc.returncode,bytes(output)
   code,text=decide('wrong-id',b'yes');assert code!=0 and b'REFUSED' in text and rows()==before
   code,text=decide('edit2',b'no');assert code!=0 and b'No decision recorded' in text and rows()==before
   code,text=decide('edit2',b'yes');assert code==0 and b'DECISION abandon recorded' in text and rows()==before
   status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120);assert status.returncode==0 and ('DECISION '+target+' abandon id=edit2').encode() in status.stdout
   code,text=decide('edit2',b'yes');assert code!=0 and b'REFUSED' in text and rows()==before
  result={'status':'passed','scope':'offline synthetic copies; check running state is injected; no model, edit, retry or rollback','targets':list(FIXTURES),'incorrect_id_refused':True,'negative_answer_preserved':True,'decision_recorded':True,'duplicate_refused':True,'original_records_and_versions_unchanged':True}
 except BaseException as error:result={'status':'failed','failure_type':type(error).__name__,'target':target if 'target' in locals() else None}
 finally:
  if proc and proc.poll() is None:
   os.killpg(proc.pid,signal.SIGTERM)
   try:proc.wait(timeout=20)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
  if master is not None:os.close(master)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
