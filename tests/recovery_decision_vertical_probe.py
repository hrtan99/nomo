#!/usr/bin/env python3
"""Exercise no/yes decisions against copied synthetic unresolved states."""
import argparse,json,os,pty,select,shutil,signal,sqlite3,subprocess,tempfile,termios,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
def rows(db):
 with sqlite3.connect(db) as c:return list(c.iterdump())
def terminal(cmd,env,answer):
 master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
 p=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);output=bytearray();answered=False;deadline=time.monotonic()+120
 try:
  while p.poll() is None:
   if time.monotonic()>deadline:raise TimeoutError()
   if select.select([master],[],[],.1)[0]:
    try:output.extend(os.read(master,65536))
    except OSError:pass
   if not answered and b'Record abandon? [y/N]' in output:os.write(master,answer.encode()+b'\n');answered=True
  while select.select([master],[],[],0)[0]:
   try:chunk=os.read(master,65536)
   except OSError:break
   if not chunk:break
   output.extend(chunk)
  return p.returncode,bytes(output),answered
 finally:
  if p.poll() is None:
   try:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=25)
   except (OSError,subprocess.TimeoutExpired):pass
  os.close(master)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--work-state',type=Path,required=True);parser.add_argument('--check-state',type=Path,required=True);args=parser.parse_args();sources={'work':args.work_state,'check':args.check_state}
 out=Path(tempfile.mkdtemp(prefix='nomo-decision-',dir='/private/tmp'));project=out/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));sessions=out/'sessions';sessions.mkdir(mode=0o700);session_id='a'*32;env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'NOMO_ETAS_VERSION':'0.2.5'};results=[]
 try:
  for target,source in sources.items():
   state=(sessions/session_id) if target=='check' else (out/target);shutil.copytree(source,state);state.chmod(0o700);db=state/'history.sqlite3';original=rows(db)
   cmd=([str(project/'scripts/nomo-read.sh'),'session-id','decision','--sessions-dir',str(sessions),'--id',session_id,'--operation-id','edit1','--target',target] if target=='check' else [str(project/'scripts/nomo-read.sh'),'session-decision','--state',str(state),'--id','edit1','--target',target])
   no,out_no,asked=terminal(cmd,env,'n');(out/(target+'-no.output')).write_bytes(out_no);assert no!=0 and asked and b'No decision recorded.' in out_no and rows(db)==original
   wrong=list(cmd);wrong[wrong.index('--operation-id' if target=='check' else '--id')+1]='wrong-id';wrong_code,wrong_output,asked=terminal(wrong,env,'yes');(out/(target+'-wrong.output')).write_bytes(wrong_output);assert wrong_code!=0 and asked and b'REFUSED work identity differs' in wrong_output and rows(db)==original
   with sqlite3.connect(db) as c:before_records=dict(c.execute("select region,value_json from memory_entries where region in ('nomo-history-work-v1','nomo-history-check-v1','nomo-edit-operation-v1')"))
   yes,out_yes,asked=terminal(cmd,env,'yes');(out/(target+'-yes.output')).write_bytes(out_yes);assert yes==0 and asked and b'DECISION abandon recorded' in out_yes
   with sqlite3.connect(db) as c:
    records=c.execute("select region,value_json from memory_entries where region in ('nomo-recovery-decision-v1','nomo-history-work-v1','nomo-history-check-v1','nomo-edit-operation-v1')").fetchall();decision=[v for r,v in records if r=='nomo-recovery-decision-v1'];assert len(decision)==1 and 'abandon' in decision[0] and target in decision[0]
    assert {r:v for r,v in records if r!='nomo-recovery-decision-v1'}==before_records
   after=rows(db);status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120);(out/(target+'-status.stdout')).write_bytes(status.stdout);assert status.returncode==0 and ('DECISION '+target+' abandon id=edit1').encode() in status.stdout and b'outcome remains unknown, no retry authorized' in status.stdout
   again,out_again,asked=terminal(cmd,env,'yes');(out/(target+'-again.output')).write_bytes(out_again);assert again!=0 and asked and b'REFUSED recovery decision already recorded' in out_again and rows(db)==after
   results.append({'target':target,'no_preserves_state':True,'wrong_id_refused':True,'original_records_unchanged':True,'yes_recorded':True,'status_shown':True,'repeat_refused':True})
  result={'status':'passed','scope':'copied synthetic unresolved work/check; abandon only, no model or workspace retry','cases':results}
 except BaseException as error:result={'status':'failed','failure_type':type(error).__name__,'cases':results}
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
