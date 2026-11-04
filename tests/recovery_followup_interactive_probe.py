#!/usr/bin/env python3
"""A confirmed first edit, interrupted followup, and a new confirmed edit."""
import json,os,pty,re,select,signal,subprocess,termios,threading,time,tempfile,shutil
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent
out=Path(tempfile.mkdtemp(prefix='nomo-followup-recovery-',dir='/private/tmp'));project=out/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir()
workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n')
sessions=out/'sessions';sessions.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
(policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');(policy/'policy.json').chmod(0o600);(policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i in (0,4,11,15,21,25):v=['delegate','Read note.txt before editing']
   elif i in (1,5,12,16,22,26):v=['read','note.txt']
   elif i in (2,6,13,17,23,27):v=['final','note.txt contains the current color']
   elif i in (3,14,24):v='EDIT note.txt'
   elif i in (7,18,28):v='note.txt contains the current color'
   elif i in (8,19,29):
    if i==29:assert 'effect is unknown' in json.dumps(ctx)
    v=['delegate','Replace the requested color']
   elif i==9:v=['edit','old','green']
   elif i in (20,30):v=['edit','green','gold']
   elif i in (10,31):v='The requested edit was applied.'
   else:raise ValueError('unexpected request '+str(i))
   content=json.dumps(v,ensure_ascii=False,separators=(',',':')) if isinstance(v,list) else v
   body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode();self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception as e:self.server.error=repr(e);self.send_error(500)
server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None;threading.Thread(target=server.serve_forever,daemon=True).start()
manifest=project/'etas.toml';text=manifest.read_text()
for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
 start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
manifest.write_text(text)
env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6'}
cmd=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--new','--root',str(workspace),'--allow','note.txt','--events-policy-dir',str(policy)]
master,slave=pty.openpty();setting=termios.tcgetattr(slave);setting[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,setting)
proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);log=bytearray();step=0;deadline=time.monotonic()+300
try:
 while proc.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('timeout step '+str(step))
  if select.select([master],[],[],0.1)[0]:
   try:
    data=os.read(master,65536)
    if data:log.extend(data);(out/'terminal.log').write_bytes(log)
   except OSError:pass
  v=bytes(log)
  if step==0 and b'nomo> ' in v:os.write(master,b'Change old to green in note.txt\n');step=1
  elif step==1 and v.count(b'Type `yes` to approve:')>=1:os.write(master,b'yes\n');step=2
  elif step==2 and v.count(b'CONFIRM Apply this exact preview?')>=1:os.write(master,b'yes\n');step=3
  elif step==3 and v.count(b'nomo> ')>=2:os.write(master,b'Change green to gold in note.txt\n');step=4
  elif step==4 and v.count(b'Type `yes` to approve:')>=2:os.kill(proc.pid,signal.SIGINT);step=5
  elif step==5 and b'Abandon this stopped operation and continue this session?' in v:os.write(master,b'yes\n');step=6
  elif step==6 and b'Continue with a new request' in v:os.write(master,b'Change green to gold in note.txt now\n');step=7
  elif step==7 and v.count(b'Type `yes` to approve:')>=3:os.write(master,b'yes\n');step=8
  elif step==8 and v.count(b'CONFIRM Apply this exact preview?')>=2:os.write(master,b'yes\n');step=9
  elif step==9 and b'SAVED additional work facts' in v and v.count(b'nomo> ')>=4:os.write(master,b'/exit\n');step=10
 while select.select([master],[],[],0)[0]:
  try:
   data=os.read(master,65536)
   if not data:break
   log.extend(data)
  except OSError:break
 (out/'terminal.log').write_bytes(log)
 assert proc.returncode==0 and step==10,(proc.returncode,step,server.error,server.seen,bytes(log)[-2000:])
 assert (workspace/'note.txt').read_text()=='before gold\n'
 identifier=re.search(rb'SESSION ID ([0-9a-f]{32})',log).group(1).decode()
 status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','status','--sessions-dir',str(sessions),'--id',identifier,'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
 (out/'status.log').write_bytes(status.stdout+status.stderr)
 assert status.returncode==0,status.stderr.decode('utf8','replace')
 views=[json.loads(line[len(b'EVENT VIEW '):]) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
 assert len(views)==1 and views[0]['work_phase']=='complete' and views[0]['followup_phase']=='abandoned' and views[0]['followup_reserved_calls']==7 and views[0]['followup_reserved_tokens']==51200 and views[0]['additional_work'][-1]['result']['phase']=='complete',views
 print(json.dumps({'status':'passed','scope':'completed first edit, normal SIGINT on followup preview, explicit abandon, same-session additional edit','fake_http':len(server.seen),'result_dir':str(out)}))
except Exception as e:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','step':step,'error':repr(e),'server_error':server.error,'phases':server.seen,'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-3000:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
