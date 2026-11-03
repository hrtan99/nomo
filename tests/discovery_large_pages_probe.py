import json,os,pty,select,signal,subprocess,termios,threading,time,tempfile,shutil
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent
out=Path(tempfile.mkdtemp(prefix='nomo-scale-',dir='/private/tmp'));project=out/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir()
workspace=out/'workspace';workspace.mkdir(mode=0o700)
subprocess.run(['git','init','-q',str(workspace)],check=True)
(workspace/'.gitignore').write_text('ignored.txt\n')
for i in range(300):
 d=workspace/('dir%03d'%i);d.mkdir()
 for j in range(4+(i<100)):(d/('file%d.txt'%j)).write_text('synthetic ordinary data\n')
(workspace/'dir299/z-target.txt').write_text('DISTINCTIVE-NEEDLE\n')
sessions=out/'sessions';sessions.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700);(policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');(policy/'policy.json').chmod(0o600);(policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i==0:assert ctx['page']==4 and ctx['more_pages'] and len(ctx['current']['allowed'])==256;v=['delegate','Search this page for the distinctive marker']
   elif i==1:v=['search','DISTINCTIVE-NEEDLE','*']
   elif i==2:v=['final','The marker is not in this page.']
   elif i==3:v='NEXT_PAGE'
   elif i==4:assert ctx['page']==5 and not ctx['more_pages'] and 'dir299/z-target.txt' in ctx['current']['allowed'];v=['delegate','Read the target file']
   elif i==5:v=['read','dir299/z-target.txt']
   elif i==6:assert 'DISTINCTIVE-NEEDLE' in json.dumps(ctx);v=['final','The marker is DISTINCTIVE-NEEDLE']
   elif i==7:v='The marker is DISTINCTIVE-NEEDLE.'
   else:raise ValueError('unexpected request '+str(i))
   content=json.dumps(v,separators=(',',':')) if isinstance(v,list) else v;body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode();self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception as e:self.server.error=repr(e);self.send_error(500)
server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None;threading.Thread(target=server.serve_forever,daemon=True).start()
manifest=project/'etas.toml';text=manifest.read_text()
for name in ('nomo-read-session-new','nomo-read-session-existing','nomo-read-events-new','nomo-read-events-existing'):
 start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');assert ('http://host.docker.internal:%d/v1'%server.server_port) in part and 'allow_private = true' in part;text=text[:start]+part+text[end:]
manifest.write_text(text)
env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6','NOMO_ETAS_GRAPH':'026-v68'}
cmd=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--new','--root',str(workspace),'--discover','--page','4','--events-policy-dir',str(policy)]
master,slave=pty.openpty();setting=termios.tcgetattr(slave);setting[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,setting);proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);log=bytearray();step=0;deadline=time.monotonic()+240
try:
 while proc.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('timeout '+str(step))
  if select.select([master],[],[],.2)[0]:
   try:log.extend(os.read(master,65536));(out/'terminal.log').write_bytes(log)
   except OSError:pass
  if step==0 and b'nomo> ' in log:os.write(master,b'Find the distinctive marker.\n');step=1
  elif step==1 and len(server.seen)==8 and log.count(b'nomo> ')>=2:os.write(master,b'/exit\n');step=2
 (out/'terminal.log').write_bytes(log)
 assert proc.returncode==0 and step==2 and server.seen==list(range(8)),(proc.returncode,step,server.error,server.seen)
 assert b'DISCOVERY PAGE 4: more candidates remain.' in log and b'DISCOVERY PAGE 5: no later candidates' in log
 print(json.dumps({'status':'passed','directories':300,'synthetic_files':1302,'pages':[4,5],'http':len(server.seen),'result_dir':str(out)}))
except Exception as e:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','error':repr(e),'server_error':server.error,'phases':server.seen,'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-3000:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
