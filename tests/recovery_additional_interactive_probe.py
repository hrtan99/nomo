#!/usr/bin/env python3
"""Continue the saved synthetic main-chain fixture through an interrupted extra edit."""
import json,os,pty,re,select,signal,subprocess,termios,threading,time,tempfile,shutil,sys
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent;fixture=Path(sys.argv[1])
out=Path(tempfile.mkdtemp(prefix='nomo-extra-recovery-',dir='/private/tmp'));project=out/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir()
for name in ('workspace','sessions','policy'):shutil.copytree(fixture/name,out/name)
workspace=out/'workspace';sessions=out/'sessions';policy=out/'policy';identifier=next(sessions.iterdir()).name
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i in (0,4,10,14):v=['delegate','Read note.txt before editing']
   elif i in (1,5,11,15):v=['read','note.txt']
   elif i in (2,6,12,16):v=['final','note.txt contains gold']
   elif i in (3,13):v='EDIT note.txt'
   elif i in (7,17):v='note.txt contains gold'
   elif i in (8,18):
    if i==18:assert 'effect is unknown' in json.dumps(ctx)
    v=['delegate','Replace gold with blue']
   elif i in (9,19):v=['edit','gold','blue']
   elif i==20:v='The requested edit was applied.'
   else:raise ValueError('unexpected request '+str(i))
   content=json.dumps(v,ensure_ascii=False,separators=(',',':')) if isinstance(v,list) else v
   body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode();self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception as e:self.server.error=repr(e);self.send_error(500)
server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None;threading.Thread(target=server.serve_forever,daemon=True).start()
manifest=project/'etas.toml';text=manifest.read_text()
for name in ('nomo-read-events-existing','nomo-history-events-work'):
 start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
manifest.write_text(text)
env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6'}
cmd=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--id',identifier,'--root',str(workspace),'--allow','note.txt','--events-policy-dir',str(policy)]
master,slave=pty.openpty();setting=termios.tcgetattr(slave);setting[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,setting)
proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);log=bytearray();step=0;deadline=time.monotonic()+240
try:
 while proc.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('timeout step '+str(step))
  if select.select([master],[],[],0.1)[0]:
   try:
    data=os.read(master,65536)
    if data:log.extend(data);(out/'terminal.log').write_bytes(log)
   except OSError:pass
  v=bytes(log)
  if step==0 and b'nomo> ' in v:os.write(master,b'Change gold to blue in note.txt\n');step=1
  elif step==1 and b'Type `yes` to approve:' in v:os.kill(proc.pid,signal.SIGINT);step=2
  elif step==2 and b'Abandon this stopped operation and continue this session?' in v:os.write(master,b'yes\n');step=3
  elif step==3 and b'Continue with a new request' in v:os.write(master,b'Change gold to blue in note.txt now\n');step=4
  elif step==4 and v.count(b'Type `yes` to approve:')>=2:os.write(master,b'yes\n');step=5
  elif step==5 and b'CONFIRM Apply this exact preview?' in v:os.write(master,b'yes\n');step=6
  elif step==6 and b'SAVED additional work facts' in v and v.count(b'nomo> ')>=3:os.write(master,b'/exit\n');step=7
 while select.select([master],[],[],0)[0]:
  try:
   data=os.read(master,65536)
   if not data:break
   log.extend(data)
  except OSError:break
 (out/'terminal.log').write_bytes(log)
 assert proc.returncode==0 and step==7,(proc.returncode,step,server.error,server.seen)
 assert (workspace/'note.txt').read_text()=='before blue\n'
 status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','status','--sessions-dir',str(sessions),'--id',identifier,'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120);(out/'status.log').write_bytes(status.stdout+status.stderr)
 assert status.returncode==0,status.stderr.decode('utf8','replace')
 views=[json.loads(line[len(b'EVENT VIEW '):]) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')];items=views[0]['additional_work']
 assert views[0]['work_phase']=='complete' and views[0]['followup_phase']=='abandoned' and len(items)==3 and items[-2]['result']['phase']=='abandoned' and items[-2]['result']['calls']==0 and items[-2]['result']['generation']==0 and items[-1]['result']['phase']=='complete',views
 assert b'phase=abandoned' in status.stdout and b'reserved_calls=7 reserved_generation=51200' in status.stdout
 print(json.dumps({'status':'passed','scope':'interrupted additional work, explicit abandon, same-session additional edit','fake_http':len(server.seen),'result_dir':str(out)}))
except Exception as e:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','step':step,'error':repr(e),'server_error':server.error,'phases':server.seen,'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-3000:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
