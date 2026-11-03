import json,os,pty,select,signal,subprocess,termios,threading,time,tempfile,shutil,re
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent;base=Path(tempfile.mkdtemp(prefix='nomo-independent-',dir='/private/tmp'));project=base/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir()
workspace=base/'workspace';workspace.mkdir(mode=0o700);(workspace/'notes.txt').write_text('synthetic context\n');(workspace/'test_probe.py').write_text('import sys\nprint("SYNTHETIC_SECRET SYNTHETIC_QWEN_SECRET AssertionError: expected green", file=sys.stderr)\nsys.exit(1)\n')
state=base/'state';state.mkdir(mode=0o700);(state/'sessions').mkdir(mode=0o700);policy=state/'policy';policy.mkdir(mode=0o700);(policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');(policy/'policy.json').chmod(0o600);(policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i==0:v=['delegate','Read the selected notes']
   elif i==1:v=['read','notes.txt']
   elif i==2:v=['final','Notes contain synthetic context']
   elif i==3:v='Notes contain synthetic context.'
   elif i==4:
    history=ctx['history'];matches=[x for x in history if x.get('name')=='independent-check'];assert len(matches)==1,history
    text=matches[0]['text'];assert 'Outcome failed' in text and 'Exit 1' in text and 'AssertionError: expected green' in text and 'SYNTHETIC_SECRET' not in text and 'SYNTHETIC_QWEN_SECRET' not in text and '[REDACTED]' in text,text
    v=['delegate','Read the selected notes for context']
   elif i==5:v=['read','notes.txt']
   elif i==6:v=['final','Notes contain synthetic context']
   elif i==7:v='The check failed with AssertionError: expected green.'
   else:raise ValueError('unexpected request '+str(i))
   content=json.dumps(v,separators=(',',':')) if isinstance(v,list) else v;body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode();self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception as e:self.server.error=repr(e);self.send_error(500)
server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None;threading.Thread(target=server.serve_forever,daemon=True).start()
manifest=project/'etas.toml';text=manifest.read_text()
text=text.replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true')
assert 'https://api.minimax.cn/v1' not in text
manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_QWEN_SERVER_API_KEY':'SYNTHETIC_QWEN_SECRET','NOMO_ETAS_VERSION':'0.2.6','NOMO_ETAS_GRAPH':'026-v68','NOMO_STATE_DIR':str(state)}
cmd=[str(project/'scripts/nomo'),'--root',str(workspace),'--allow','notes.txt'];master,slave=pty.openpty();setting=termios.tcgetattr(slave);setting[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,setting);proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);log=bytearray();step=0;deadline=time.monotonic()+180
try:
 while proc.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('step '+str(step))
  if select.select([master],[],[],.1)[0]:
   try:log.extend(os.read(master,65536));(base/'terminal.log').write_bytes(log)
   except OSError:pass
  if step==0 and b'nomo> ' in log:os.write(master,b'Read the selected notes.\n');step=1
  elif step==1 and len(server.seen)==4 and log.count(b'nomo> ')>=2:os.write(master,b'/check python3 test_probe.py\n');step=2
  elif step==2 and b'Automatic check for future natural edits:' in log:os.write(master,b'/check --run\n');step=3
  elif step==3 and b'INDEPENDENT CHECK SAVED' in log and log.count(b'nomo> ')>=4:os.write(master,b'/exit\n');step=4
 (base/'terminal.log').write_bytes(log);assert proc.returncode==0 and step==4 and server.seen==list(range(4)),(proc.returncode,step,server.error,server.seen)
 ids=re.findall(rb'(?:^|nomo> )SESSION ID ([0-9a-f]{32})\r?$',bytes(log),re.M);assert len(ids)==1,ids
 resumed=subprocess.run([str(project/'scripts/nomo'),'--root',str(workspace),'--allow','notes.txt','--id',ids[0].decode(),'--once','Explain the failed check.'],env=env,input=b'',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
 (base/'resume.stdout').write_bytes(resumed.stdout);(base/'resume.stderr').write_bytes(resumed.stderr)
 assert resumed.returncode==0 and server.seen==list(range(8)),(resumed.returncode,server.error,server.seen,resumed.stderr[-1000:])
 assert all(secret not in value for secret in (b'SYNTHETIC_SECRET', b'SYNTHETIC_QWEN_SECRET') for value in (log, resumed.stdout, resumed.stderr))
 print(json.dumps({'status':'passed','http':len(server.seen),'evidence':str(base)}))
except Exception as e:
 (base/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','error':repr(e),'server_error':server.error,'phases':server.seen,'evidence':str(base),'tail':bytes(log).decode('utf8','replace')[-2200:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
