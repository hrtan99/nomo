#!/usr/bin/env python3
"""Synthetic session: hide progress payloads while preserving final and model context."""
import json,os,shutil,sqlite3,subprocess,tempfile,threading
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
TASK='NOMO_SENSITIVE_TASK_X';RESULT='NOMO_SENSITIVE_RESULT_X';TOOL='NOMO_SENSITIVE_TOOL_X'
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def do_POST(self):
  try:
   assert self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY' and self.path=='/v1/chat/completions'
   body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));assert body['max_tokens']==2048
   ctx=json.loads(body['messages'][1]['content']);i=len(self.server.phases)
   if i==0:value=['delegate','Read context.txt '+TASK]
   elif i==1:value=['read','context.txt']
   elif i==2:value=['final',RESULT]
   elif i==3:
    assert TASK in ctx['task'] and RESULT in ctx['result'] and TOOL in ctx['outcome'];value='Synthetic answer.'
   else:raise ValueError('unexpected request')
   content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
   raw=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
   self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
  except Exception:
   self.server.failed=True
   try:self.send_error(500)
   except OSError:pass

def main():
 out=Path(tempfile.mkdtemp(prefix='nomo-progress-privacy-',dir='/private/tmp'));project=out/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','__pycache__'))
 context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text(TOOL+'\n');state=out/'state';state.mkdir(mode=0o700)
 server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try:
  p=project/'etas.toml';text=p.read_text();name='nomo-read-session-new';start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
  part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');p.write_text(text[:start]+part+text[end:])
  env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY'}
  proc=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Read the fixture.'],env=env,capture_output=True,timeout=120)
  (out/'stdout').write_bytes(proc.stdout);(out/'stderr').write_bytes(proc.stderr)
  assert proc.returncode==0 and server.phases==list(range(4)) and not server.failed
  output=proc.stdout+proc.stderr;assert all(x.encode() not in output for x in (TASK,RESULT,TOOL));assert b'FINAL Synthetic answer.' in proc.stdout
  assert all(x in proc.stdout for x in (b'EVENT main -> child-1 request child-1: [REDACTED]',b'EVENT child-1 -> main result child-1: [REDACTED]',b'EVENT main -> main consume child-1: [REDACTED]',b'EVENT main -> main tool read: [REDACTED]',b'CHILD EVENT user input : [REDACTED]',b'CHILD EVENT tool complete read: [REDACTED]',b'CHILD EVENT assistant final : [REDACTED]'))
  with sqlite3.connect(state/'history.sqlite3') as c:
   assert c.execute('pragma integrity_check').fetchone()==('ok',);raw=c.execute("select value_json from memory_entries where region='nomo-chat-history-v3'").fetchone()[0]
   assert all(x in raw for x in (TASK,RESULT,TOOL))
  result={'status':'passed','scope':'synthetic session progress only; final answer shown and saved chat remains plaintext','fake_requests':4,'progress_payloads_hidden':True,'final_preserved':True,'model_received_tool_result':True,'persistent_chat_still_contains_sentinels':True}
 except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'phases':server.phases}
 finally:server.shutdown();server.server_close();thread.join(timeout=5)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
