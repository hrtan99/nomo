#!/usr/bin/env python3
"""Discover nested project files, then let an agent choose and read one."""
import json,os,pty,select,signal,subprocess,termios,threading,time,tempfile,shutil,re
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent
out=Path(tempfile.mkdtemp(prefix='nomo-discovery-',dir='/private/tmp'));project=out/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir()
workspace=out/'workspace';workspace.mkdir(mode=0o700)
for i in range(40):(workspace/('alpha%02d.txt'%i)).write_text('ordinary synthetic data '*30+'\n')
(workspace/'binary.bin').write_bytes(b'\xff\xfe');(workspace/'oversized.txt').write_text('x'*17000)
(workspace/'src/app').mkdir(parents=True);(workspace/'src/app/greeting.py').write_text('GREETING = "hello from nested project"\n')
(workspace/'node_modules').mkdir();(workspace/'node_modules/ignored.txt').write_text('excluded dependency\n');(workspace/'.private').mkdir();(workspace/'.private/hidden.txt').write_text('excluded hidden\n')
sessions=out/'sessions';sessions.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700);(policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');(policy/'policy.json').chmod(0o600);(policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i in (1,2,3):assert req.get('max_tokens')==4096,('child output budget',req.get('max_tokens'))
   if i in (0,4):assert req.get('max_tokens')==2048,('parent output budget',req.get('max_tokens'))
   if i==0:
    files=ctx['current']['allowed'];assert len(files)==44 and 'src/app/greeting.py' in files and '.private/hidden.txt' in files and not any(x.startswith('node_modules/') for x in files),files
    self.server.files=files;v=['delegate','Read the project file defining the greeting']
   elif i==1:v=['search','hello from nested project','*']
   elif i==2:assert 'incomplete:' in json.dumps(ctx) and 'src/app/greeting.py:1' in json.dumps(ctx);v=['read','src/app/greeting.py']
   elif i==3:v=['final','Greeting is hello from nested project']
   elif i==4:v='EDIT src/app/greeting.py'
   elif i==5:v=['delegate','Read the selected greeting file']
   elif i==6:v=['read','src/app/greeting.py']
   elif i==7:v=['final','The greeting is hello from nested project']
   elif i==8:v='The greeting is hello from nested project'
   elif i==9:v=['delegate','Change the greeting']
   elif i==10:v=['edit','hello from nested project','hello to users']
   elif i==11:v='Updated the greeting.'
   else:raise ValueError('unexpected request '+str(i))
   content=json.dumps(v,ensure_ascii=False,separators=(',',':')) if isinstance(v,list) else v;body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode();self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception as e:self.server.error=repr(e);self.send_error(500)
server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None;server.files=[];threading.Thread(target=server.serve_forever,daemon=True).start()
manifest=project/'etas.toml';text=manifest.read_text()
for name in ('nomo-read-session-new','nomo-read-session-existing','nomo-history-work'):
 start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
manifest.write_text(text)
env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6'}
cmd=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--new','--root',str(workspace),'--discover','--check','/bin/sh','-c','grep -q users src/app/greeting.py']
master,slave=pty.openpty();setting=termios.tcgetattr(slave);setting[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,setting);proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);log=bytearray();step=0;deadline=time.monotonic()+180
try:
 while proc.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('timeout step '+str(step))
  if select.select([master],[],[],0.1)[0]:
   try:
    data=os.read(master,65536)
    if data:log.extend(data);(out/'terminal.log').write_bytes(log)
   except OSError:pass
  v=bytes(log)
  if step==0 and b'nomo> ' in v:os.write(master,b'Change the project greeting to hello to users.\n');step=1
  elif step==1 and b'Type `yes` to approve:' in v:
   previews=[line.removeprefix(b'PREVIEW ') for line in v.splitlines() if line.startswith(b'PREVIEW ')];assert len(previews)==1;preview=json.loads(previews[0]);assert preview['path']=='src/app/greeting.py' and preview['before']=='GREETING = "hello from nested project"\n' and preview['after']=='GREETING = "hello to users"\n';os.write(master,b'yes\n');step=2
  elif step==2 and b'CONFIRM Apply this exact preview?' in v:os.write(master,b'yes\n');step=3
  elif step==3 and b'Check passed.' in v and v.count(b'nomo> ')>=2:os.write(master,b'/exit\n');step=4
 while select.select([master],[],[],0)[0]:
  try:
   data=os.read(master,65536)
   if not data:break
   log.extend(data)
  except OSError:break
 (out/'terminal.log').write_bytes(log)
 assert proc.returncode==0 and step==4 and server.seen==list(range(12)),(proc.returncode,step,server.error,server.seen)
 assert b'Search incomplete:' in log and b'SAVED chat history' in log and (workspace/'src/app/greeting.py').read_text()=='GREETING = \"hello to users\"\n'
 print(json.dumps({'status':'passed','scope':'bounded multilevel discovery; agent chooses, reads and edits a nested file among 44 candidates with explicit incomplete results','candidate_count':len(server.files),'files':server.files,'fake_http':len(server.seen),'result_dir':str(out)}))
except Exception as e:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','step':step,'error':repr(e),'server_error':server.error,'phases':server.seen,'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-3000:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
