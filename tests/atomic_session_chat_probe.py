#!/usr/bin/env python3
"""Synthetic stable-ID session-chat TTY over atomic redacted event metadata."""
import json,os,pty,re,select,shutil,signal,sqlite3,subprocess,tempfile,termios,threading,time
from http.server import HTTPServer
from pathlib import Path
from read_session_vertical_probe import Fake
ROOT=Path(__file__).resolve().parent.parent
def main():
 out=Path(tempfile.mkdtemp(prefix='nomo-atomic-session-chat-',dir='/private/tmp'));project=out/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));sessions=out/'sessions';sessions.mkdir(mode=0o700);ctx=out/'context';ctx.mkdir(mode=0o700);(ctx/'context.txt').write_text('blue\n');ctx2=out/'current';ctx2.mkdir(mode=0o700);(ctx2/'context.txt').write_text('green\n')
 server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();proc=None;master=None
 try:
  p=project/'etas.toml';text=p.read_text()
  for name in ('nomo-read-session-new','nomo-read-session-existing'):
   start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
  p.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
  first=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','start','--sessions-dir',str(sessions),'--root',str(ctx),'--allow','context.txt','--once','Read color and include CEDAR42'],env=env,capture_output=True,timeout=120);(out/'first.stdout').write_bytes(first.stdout);assert first.returncode==0 and server.phases==list(range(4));ids=re.findall(rb'^SESSION ID ([0-9a-f]{32})$',first.stdout,re.M);assert len(ids)==1;sid=ids[0].decode()
  cmd=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--id',sid,'--root',str(ctx2),'--allow','context.txt'];master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings);proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
  output=bytearray();sent=0;deadline=time.monotonic()+120;commands=(b'/help\n',b'What tag was in the previous answer?\n',b'/exit\n')
  while proc.poll() is None:
   if time.monotonic()>deadline:raise TimeoutError()
   if select.select([master],[],[],.1)[0]:
    try:output.extend(os.read(master,65536))
    except OSError:pass
   if sent<3 and output.count(b'nomo> ')>sent:
    os.write(master,commands[sent]);sent+=1
  while select.select([master],[],[],0)[0]:
   try:data=os.read(master,65536)
   except OSError:break
   if not data:break
   output.extend(data)
  (out/'chat.output').write_bytes(output);assert proc.returncode==0 and sent==3 and b'FINAL CEDAR42' in output and server.phases==list(range(8)) and not server.failed
  with sqlite3.connect(sessions/sid/'history.sqlite3') as c:
   rows=c.execute("select region,value_json from memory_entries where region in ('nomo-chat-history-v1','nomo-event-history-v1','nomo-chat-history-v3')").fetchall();assert len(rows)==1 and rows[0][0]=='nomo-chat-history-v3';frame=json.loads(rows[0][1]);fields={x['name']:x['value'] for x in frame['fields']};assert len(fields['events']['items'])>1
  result={'status':'passed','scope':'synthetic read-only session-chat TTY and v3 atomic metadata; no workspace identity or real model','fake_requests':8,'help_then_turn_then_exit':True,'atomic_frame_present':True}
 except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'phases':server.phases,'exit':proc.poll() if proc else None}
 finally:
  if proc and proc.poll() is None:
   try:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
   except (OSError,subprocess.TimeoutExpired):pass
  if master is not None:os.close(master)
  server.shutdown();server.server_close();thread.join(timeout=5)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
