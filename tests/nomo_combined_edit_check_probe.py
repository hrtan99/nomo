#!/usr/bin/env python3
"""One natural edit-and-check request, with separate approvals and recorded result."""
import json,os,pty,re,select,shutil,signal,subprocess,tempfile,termios,threading,time
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent
out=Path(tempfile.mkdtemp(prefix='nomo-combined-edit-check-',dir='/private/tmp'));project=out/'project'
shutil.copytree(root,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__'));(project/'.etas').mkdir()
workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n')
(workspace/'check.py').write_text('from pathlib import Path\np=Path("ran.txt")\np.write_text(str(int(p.read_text())+1) if p.exists() else "1")\nprint("SYNTHETIC_CHECK_42")\nraise SystemExit(3)\n')
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i in (0,4):v=['delegate','Read note.txt before editing']
   elif i in (1,5):v=['read','note.txt']
   elif i in (2,6):v=['final','note.txt contains before old']
   elif i==3:v='EDIT_CHECK note.txt'
   elif i==7:v='note.txt contains before old'
   elif i==8:v=['delegate','Change old to new']
   elif i==9:v=['edit','old','new']
   elif i==10:v='The requested edit was applied.'
   elif i==11:
    assert ctx['current']['request'].startswith('AUTO-CONTINUATION:') and 'completed edit auto-' in ctx['current']['request']
    v=['delegate','Read check.py to identify a suitable check']
   elif i in (12,16):v=['read','check.py']
   elif i in (13,17):v=['final','check.py is the appropriate check']
   elif i==14:v='CHECK python3 check.py'
   elif i==15:
    checks=[e for e in ctx['history'] if e['kind']=='check' and e['name']=='independent-check']
    assert len(checks)==1 and 'Exit 3' in checks[0]['text'] and 'SYNTHETIC_CHECK_42' in checks[0]['text']
    v=['delegate','Read check.py and summarize the recorded result']
   elif i==18:v='检查失败，退出码 3，输出 SYNTHETIC_CHECK_42。'
   else:raise ValueError('unexpected request '+str(i))
   content=json.dumps(v,ensure_ascii=False,separators=(',',':')) if isinstance(v,list) else v
   body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}},ensure_ascii=False).encode();self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception as e:self.server.error=repr(e);self.send_error(500)
server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None;threading.Thread(target=server.serve_forever,daemon=True).start()
manifest=project/'etas.toml';text=manifest.read_text()
for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
 start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
manifest.write_text(text)
env={'PATH':'/Applications/Docker.app/Contents/Resources/bin:'+os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6','NOMO_ETAS_GRAPH':'026-v68','NOMO_STATE_DIR':str(out/'state')}
command=[str(project/'scripts/nomo'),'--root',str(workspace),'--allow','note.txt,check.py']
master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
proc=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);log=bytearray();step=0;deadline=time.monotonic()+240
try:
 while proc.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('step '+str(step))
  if select.select([master],[],[],.1)[0]:
   try:
    data=os.read(master,65536)
    if data:log.extend(data);(out/'terminal.log').write_bytes(log)
   except OSError:pass
  view=bytes(log)
  if step==0 and b'nomo> ' in view:os.write(master,'把 note.txt 的 old 改成 new 并运行 check.py。\n'.encode());step=1
  elif step==1 and b'Type `yes` to approve:' in view:
   previews=[json.loads(line.removeprefix(b'PREVIEW ')) for line in view.splitlines() if line.startswith(b'PREVIEW ')]
   assert len(previews)==1 and previews[0]['before']=='before old\n' and previews[0]['after']=='before new\n'
   os.write(master,b'yes\n');step=2
  elif step==2 and b'CONFIRM Apply this exact preview?' in view:os.write(master,b'yes\n');step=3
  elif step==3 and b'Run this exact command? [y/N]' in view:
   assert b'Proposed check: python3 check.py' in view and (workspace/'note.txt').read_text()=='before new\n' and not (workspace/'ran.txt').exists()
   os.write(master,b'yes\n');step=4
  elif step==4 and '检查失败，退出码 3'.encode() in view:
   assert (workspace/'ran.txt').read_text()=='1';os.write(master,b'/events\n');step=5
  elif step==5 and b'independent-check' in view:os.write(master,b'/exit\n');step=6
 while select.select([master],[],[],0)[0]:
  try:
   data=os.read(master,65536)
   if not data:break
   log.extend(data)
  except OSError:break
 (out/'terminal.log').write_bytes(log)
 assert proc.returncode==0 and step==6 and server.seen==list(range(19)),(proc.returncode,step,server.error,server.seen,bytes(log)[-2500:])
 assert (workspace/'ran.txt').read_text()=='1' and b'work-boundary' in log and b'independent-check' in log
 print(json.dumps({'status':'passed','scope':'one natural edit-and-test request; two edit confirmations; separately approved failed check and recorded model summary','fake_http':len(server.seen),'result_dir':str(out)}))
except Exception as error:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','step':step,'error':repr(error),'server_error':server.error,'phases':server.seen,'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-4000:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
