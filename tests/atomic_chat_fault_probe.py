#!/usr/bin/env python3
"""Inject failures before/after the single durable frame commit."""
import json,os,shutil,sqlite3,subprocess,tempfile,threading
from http.server import HTTPServer
from pathlib import Path
from read_session_vertical_probe import Fake
ROOT=Path(__file__).resolve().parent.parent
def main():
 out=Path(tempfile.mkdtemp(prefix='nomo-atomic-fault-',dir='/private/tmp'));results=[]
 try:
  for phase in ('before','after'):
   case=out/phase;case.mkdir();project=case/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));state=case/'state';state.mkdir(mode=0o700);ctx=case/'context';ctx.mkdir(mode=0o700);(ctx/'context.txt').write_text('blue\n')
   server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   try:
    source=project/'src/nomo/session/chat_history.es';text=source.read_text();needle='    let intent = prepare_put(Frames.Rows, "latest", frame, condition); let operation = operation_ref(intent);';assert text.count(needle)==1
    if phase=='before':text=text.replace(needle,'    if value.invocation.admitted == 1 { return Err("INJECTED before frame commit"); }\n'+needle)
    else:
     pos=text.index(needle);receipt='    if receipt.operation.key != operation.key';idx=text.index(receipt,pos);text=text[:idx]+'    if value.invocation.admitted == 1 { return Err("INJECTED after frame commit"); }\n'+text[idx:]
    source.write_text(text);manifest=project/'etas.toml';text=manifest.read_text();name='nomo-read-session-new';start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');manifest.write_text(text[:start]+part+text[end:])
    env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
    run=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-new','--root',str(ctx),'--state',str(state),'--allow','context.txt','--once','Read color and include CEDAR42'],env=env,capture_output=True,timeout=120);(case/'run.stdout').write_bytes(run.stdout);(case/'run.stderr').write_bytes(run.stderr);assert run.returncode!=0 and ('INJECTED '+phase+' frame commit').encode() in run.stdout and b'SAVED chat history' not in run.stdout and server.phases==list(range(4))
    db=state/'history.sqlite3'
    with sqlite3.connect(db) as c:
     rows=c.execute("select region,value_json from memory_entries where region in ('nomo-chat-history-v1','nomo-chat-history-v3','nomo-event-history-v1')").fetchall();assert len(rows)==1 and rows[0][0]=='nomo-chat-history-v3';frame=json.loads(rows[0][1]);fields={x['name']:x['value'] for x in frame['fields']};chat={x['name']:x['value'] for x in fields['chat']['fields']};events=fields['events']['items']
     if phase=='before':assert chat['phase']['value']=='running' and len(events)==0
     else:assert chat['phase']['value']=='ready' and len(events)>0 and all(next(x for x in e['fields'] if x['name']=='text')['value']['value']=='[REDACTED]' for e in events)
    status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120);(case/'status.stdout').write_bytes(status.stdout);assert status.returncode==0 and (b'SESSION running turns=0' if phase=='before' else b'SESSION ready turns=1') in status.stdout
    results.append({'phase':phase,'single_frame':True,'expected_atomic_state':True,'no_success_marker':True,'model_requests':4})
   finally:server.shutdown();server.server_close();thread.join(timeout=5)
  result={'status':'passed','scope':'synthetic fault before/after atomic frame commit; no real provider','cases':results}
 except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'cases':results}
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
