#!/usr/bin/env python3
"""Exercise format-1/2 session compatibility and unresolved format-2 state."""
import argparse,json,os,shutil,sqlite3,subprocess,tempfile,threading
from http.server import HTTPServer
from pathlib import Path
from read_session_vertical_probe import Fake
ROOT=Path(__file__).resolve().parent.parent
def override(project,port):
 p=project/'etas.toml';text=p.read_text()
 for name in ('nomo-read-session-new','nomo-read-session-existing'):
  start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
 p.write_text(text)
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--old-project',type=Path,required=True);ap.add_argument('--pending-state',type=Path,required=True);ap.add_argument('--decision-state',type=Path,required=True);args=ap.parse_args()
 out=Path(tempfile.mkdtemp(prefix='nomo-atomic-compat-',dir='/private/tmp'));old=out/'old';new=out/'new';shutil.copytree(args.old_project,old,ignore=shutil.ignore_patterns('.etas','__pycache__'));shutil.copytree(ROOT,new,ignore=shutil.ignore_patterns('.etas','__pycache__'));state=out/'v2';state.mkdir(mode=0o700);ctx=out/'context';ctx.mkdir(mode=0o700);(ctx/'context.txt').write_text('blue\n');ctx2=out/'current';ctx2.mkdir(mode=0o700);(ctx2/'context.txt').write_text('green\n')
 server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
 def run(project,action,st,root,question):return subprocess.run([str(project/'scripts/nomo-read.sh'),action,'--state',str(st),'--root',str(root),'--allow','context.txt','--once',question],env=env,capture_output=True,timeout=120)
 def status(st):return subprocess.run([str(new/'scripts/nomo-read.sh'),'session-status','--state',str(st)],env=env,capture_output=True,timeout=120)
 try:
  override(old,server.server_port);override(new,server.server_port)
  first=run(old,'session-new',state,ctx,'Read color and include CEDAR42');(out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr);assert first.returncode==0 and server.phases==list(range(4))
  v1=out/'v1';shutil.copytree(state,v1);db=v1/'history.sqlite3'
  with sqlite3.connect(db) as c:
   raw=c.execute("select value_json from memory_entries where region='nomo-chat-history-v1'").fetchone()[0];value=json.loads(raw);field=next(x for x in value['fields'] if x['name']=='format');assert field['value']['value']=='2';field['value']['value']='1';c.execute("update memory_entries set value_json=? where region='nomo-chat-history-v1'",(json.dumps(value,separators=(',',':')),));c.execute("delete from memory_entries where region='nomo-event-history-v1'")
  c.close()
  second=run(new,'session-continue',state,ctx2,'What tag was in the previous answer?');(out/'v2.stdout').write_bytes(second.stdout);(out/'v2.stderr').write_bytes(second.stderr);assert second.returncode==0 and b'FINAL CEDAR42' in second.stdout and server.phases==list(range(8))
  v2status=status(state);(out/'v2-status.stdout').write_bytes(v2status.stdout);assert v2status.returncode==0 and b'EVENTS recorded turns=2; free text redacted' in v2status.stdout and b'atomically stored' not in v2status.stdout
  server.phases=list(range(4));legacy=run(new,'session-continue',v1,ctx2,'What tag was in the previous answer?');(out/'v1.stdout').write_bytes(legacy.stdout);(out/'v1.stderr').write_bytes(legacy.stderr);assert legacy.returncode==0 and b'FINAL CEDAR42' in legacy.stdout and server.phases==list(range(8))
  one=status(v1);(out/'v1-status.stdout').write_bytes(one.stdout);assert one.returncode==0 and b'EVENTS unavailable for legacy history' in one.stdout
  pending=out/'pending';shutil.copytree(args.pending_state,pending);before=status(pending);(out/'pending-status.stdout').write_bytes(before.stdout);assert before.returncode==0 and b'EVENTS pending; chat turn not committed, do not retry' in before.stdout
  server.phases=list(range(4));refusal=run(new,'session-continue',pending,ctx2,'Retry');(out/'pending-retry.stdout').write_bytes(refusal.stdout);assert refusal.returncode!=0 and b'REFUSED event history pending' in refusal.stdout and server.phases==list(range(4))
  decision=out/'decision';shutil.copytree(args.decision_state,decision);recorded=status(decision);(out/'decision-status.stdout').write_bytes(recorded.stdout);assert recorded.returncode==0 and b'DECISION work abandon id=edit1' in recorded.stdout and b'EVENTS recorded turns=1' in recorded.stdout
  result={'status':'passed','scope':'synthetic old format-1/2 continuity and pending refusal; no physical root identity','v2_continue':True,'v1_continue':True,'pending_refused':True,'decision_status_preserved':True}
 except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'phases':server.phases}
 finally:server.shutdown();server.server_close();thread.join(timeout=5)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
