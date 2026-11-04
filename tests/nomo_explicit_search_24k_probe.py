#!/usr/bin/env python3
"""A 24 KiB explicitly selected file is searchable before a confirmed edit."""
import json,os,pty,re,select,shutil,signal,subprocess,tempfile,termios,threading,time
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent
out=Path(tempfile.mkdtemp(prefix='nomo-explicit-search-',dir='/private/tmp'));project=out/'project'
shutil.copytree(root,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__'));(project/'.etas').mkdir()
workspace=out/'workspace';workspace.mkdir(mode=0o700);before='padding\n'*3071+'old\nxxxx';after=before.replace('old\n','new\n');assert len(before.encode())==24576
(workspace/'note.txt').write_text(before);(workspace/'context.txt').write_text('synthetic context\n')
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i==0:v=['delegate','Search the selected files to locate old']
   elif i==1:v=['search','old','context.txt']
   elif i==2:v=['search','old','note.txt']
   elif i==3:
    encoded=json.dumps(ctx);assert 'note.txt:3072' in encoded and 'complete' in encoded
    v=['final','old occurs in note.txt on line 3072']
   elif i==4:v='EDIT note.txt'
   elif i==5:v=['delegate','Search note.txt for the selected edit']
   elif i==6:v=['search','old','note.txt']
   elif i==7:v=['final','old occurs in note.txt on line 3072']
   elif i==8:v='note.txt contains old on line 3072'
   elif i==9:v=['delegate','Replace the unique old line with new']
   elif i==10:v=['edit','old\n','new\n']
   elif i==11:v='Changed the unique old line to new.'
   elif i==12:
    assert ctx['current']['request'].startswith('AUTO-CONTINUATION (no new user input):')
    v=['delegate','Read context.txt and report the recorded check']
   elif i==13:v=['read','context.txt']
   elif i==14:v=['final','The check result was recorded']
   elif i==15:v='检查通过，退出码 0。'
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
command=[str(project/'scripts/nomo'),'--root',str(workspace),'--allow','note.txt,context.txt','--check','/bin/sh','-c','grep -qx new note.txt']
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
  if step==0 and b'nomo> ' in view:os.write(master,'请把 note.txt 中单独一行的 old 改成 new，其他内容保持不变。\n'.encode());step=1
  elif step==1 and b'Type `yes` to approve:' in view:
   previews=[json.loads(line.removeprefix(b'PREVIEW ')) for line in view.splitlines() if line.startswith(b'PREVIEW ')]
   assert len(previews)==1 and previews[0]['path']=='note.txt' and previews[0]['before']==before and previews[0]['after']==after and (workspace/'note.txt').read_text()==before
   os.write(master,b'yes\n');step=2
  elif step==2 and b'CONFIRM Apply this exact preview?' in view:os.write(master,b'yes\n');step=3
  elif step==3 and '检查通过，退出码 0'.encode() in view:os.write(master,b'/exit\n');step=4
 while select.select([master],[],[],0)[0]:
  try:
   data=os.read(master,65536)
   if not data:break
   log.extend(data)
  except OSError:break
 (out/'terminal.log').write_bytes(log)
 assert proc.returncode==0 and step==4 and server.seen==list(range(16)),(proc.returncode,step,server.error,server.seen,bytes(log)[-2200:])
 assert (workspace/'note.txt').read_text()==after and (workspace/'context.txt').read_text()=='synthetic context\n' and b'Check passed.' in log
 print(json.dumps({'status':'passed','scope':'24 KiB explicit-file search, confirmed edit and check','fake_http':len(server.seen),'result_dir':str(out)}))
except Exception as error:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','step':step,'error':repr(error),'server_error':server.error,'phases':server.seen,'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-3500:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
