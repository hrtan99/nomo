#!/usr/bin/env python3
"""Fault-inject between event and chat writes; do not retry an unresolved turn."""
import json,os,shutil,sqlite3,subprocess,tempfile,threading
from http.server import HTTPServer
from pathlib import Path
from read_session_vertical_probe import Fake
ROOT=Path(__file__).resolve().parent.parent
def main():
 out=Path(tempfile.mkdtemp(prefix='nomo-event-fault-',dir='/private/tmp'));project=out/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'))
 context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n');state=out/'state';state.mkdir(mode=0o700)
 server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try:
  source=project/'src/nomo/entry/read_session.es';text=source.read_text();needle='    match save(next, Some(reserved)) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }';assert text.count(needle)==1;text=text.replace(needle,'    if next.invocation.admitted == 1 { println("INJECTED between event and chat commit"); return 1; }\n'+needle);source.write_text(text)
  manifest=project/'etas.toml';text=manifest.read_text()
  for name in ('nomo-read-session-new','nomo-read-session-existing'):
   start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
  manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
  cmd=[str(project/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Read color and include CEDAR42'];first=subprocess.run(cmd,env=env,capture_output=True,timeout=120);(out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
  assert first.returncode!=0 and b'INJECTED between event and chat commit' in first.stdout and b'SAVED chat history' not in first.stdout and server.phases==list(range(4))
  db=state/'history.sqlite3'
  with sqlite3.connect(db) as c:
   rows=dict(c.execute("select region,value_json from memory_entries where region in ('nomo-event-history-v1','nomo-chat-history-v1')"));assert len(rows)==2
   event=rows['nomo-event-history-v1'];assert 'CEDAR42' not in event and 'blue' not in event and '[REDACTED]' in event
   before=list(c.iterdump());assert c.execute('pragma integrity_check').fetchone()==('ok',)
  status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120);(out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
  assert status.returncode==0 and b'SESSION running turns=0' in status.stdout and b'EVENTS pending; chat turn not committed, do not retry' in status.stdout
  retry=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Retry'],env=env,capture_output=True,timeout=120);(out/'retry.stdout').write_bytes(retry.stdout);(out/'retry.stderr').write_bytes(retry.stderr)
  assert retry.returncode!=0 and b'REFUSED' in retry.stdout and server.phases==list(range(4))
  with sqlite3.connect(db) as c:assert list(c.iterdump())==before
  result={'status':'passed','scope':'synthetic injected fault between independent event and chat commits','fake_requests':4,'event_content_redacted':True,'pending_status':True,'retry_refused':True,'state_unchanged_on_refusal':True}
 except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'phases':server.phases}
 finally:server.shutdown();server.server_close();thread.join(timeout=5)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
