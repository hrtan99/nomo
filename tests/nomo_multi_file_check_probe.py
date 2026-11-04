#!/usr/bin/env python3
"""One request edits two existing files, then runs one separately approved check."""
import json,os,pty,re,select,shutil,signal,subprocess,tempfile,termios,threading,time
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
root=Path(__file__).resolve().parent.parent
out=Path(tempfile.mkdtemp(prefix='nomo-multi-file-',dir='/private/tmp'));project=out/'project'
shutil.copytree(root,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__'));(project/'.etas').mkdir()
workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'first.txt').write_text('first old\n');(workspace/'second.txt').write_text('second old\n')
(workspace/'check.py').write_text('from pathlib import Path\np=Path("ran.txt")\np.write_text(str(int(p.read_text())+1) if p.exists() else "1")\nassert Path("first.txt").read_text()=="first new\\n"\nassert Path("second.txt").read_text()=="second new\\n"\nprint("TWO_FILES_CHECKED")\n')
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.seen)
   if i in (0,3,6,9,11,14,17,20,22,25,26,29):assert req['max_tokens']==131072
   if i in (0,4):v=['delegate','Read first.txt before editing']
   elif i in (1,5):v=['read','first.txt']
   elif i in (2,6):v=['final','first.txt contains first old']
   elif i==3:v='EDIT_MORE_CHECK first.txt'
   elif i==7:v='first.txt contains first old'
   elif i==8:v=['delegate','Change the first file from old to new']
   elif i==9:v=['edit','old','new']
   elif i==10:v='The first file was edited.'
   elif i==11:
    assert ctx['current']['request'].startswith('AUTO-CONTINUATION:') and 'completed edit auto-' in ctx['current']['request']
    v=['delegate','Read the second requested file']
   elif i in (12,16):v=['read','second.txt']
   elif i in (13,17):v=['final','second.txt contains second old']
   elif i==14:v='EDIT second.txt'
   elif i==15:v=['delegate','Read second.txt before editing']
   elif i==18:v='second.txt contains second old'
   elif i==19:v=['delegate','Change the second file from old to new']
   elif i==20:v=['edit','old','new']
   elif i==21:v='The second file was edited.'
   elif i==22:
    assert ctx['current']['request'].startswith('AUTO-CONTINUATION:') and 'completed edit auto-' in ctx['current']['request']
    v=['delegate','Read check.py to select the check']
   elif i in (23,27):v=['read','check.py']
   elif i in (24,28):v=['final','check.py checks both files']
   elif i==25:v='CHECK python3 check.py'
   elif i==26:
    checks=[e for e in ctx['history'] if e['kind']=='check' and e['name']=='independent-check']
    assert len(checks)==1 and 'Exit 0' in checks[0]['text'] and 'TWO_FILES_CHECKED' in checks[0]['text']
    v=['delegate','Read check.py and summarize the recorded result']
   elif i==29:v='检查通过，退出码 0，输出 TWO_FILES_CHECKED。'
   else:raise ValueError('unexpected request '+str(i))
   content=json.dumps(v,ensure_ascii=False,separators=(',',':')) if isinstance(v,list) else v
   body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}},ensure_ascii=False).encode();self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception as e:self.server.error=repr(e);self.send_error(500)
server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None;threading.Thread(target=server.serve_forever,daemon=True).start()
manifest=project/'etas.toml';text=manifest.read_text()
for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
 start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
manifest.write_text(text)
env={'PATH':'/Applications/Docker.app/Contents/Resources/bin:'+os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.3.0','NOMO_ETAS_GRAPH':'030-pr67','NOMO_STATE_DIR':str(out/'state')}
command=[str(project/'scripts/nomo'),'--root',str(workspace),'--allow','first.txt,second.txt,check.py']
master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
proc=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);log=bytearray();step=0;deadline=time.monotonic()+360
try:
 while proc.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('step '+str(step))
  if select.select([master],[],[],.1)[0]:
   try:
    data=os.read(master,65536)
    if data:log.extend(data);(out/'terminal.log').write_bytes(log)
   except OSError:pass
  view=bytes(log)
  if step==0 and b'nomo> ' in view:os.write(master,'把 first.txt 和 second.txt 的 old 都改为 new，然后运行 check.py。\n'.encode());step=1
  elif step in (1,3) and view.count(b'Type `yes` to approve:') >= (1 if step==1 else 2):
   previews=[json.loads(line.removeprefix(b'PREVIEW ')) for line in view.splitlines() if line.startswith(b'PREVIEW ')]
   index=0 if step==1 else 1;name=['first.txt','second.txt'][index];assert len(previews)==index+1 and previews[index]['path']==name and previews[index]['before']==name.split('.')[0]+' old\n' and previews[index]['after']==name.split('.')[0]+' new\n'
   os.write(master,b'yes\n');step+=1
  elif step in (2,4) and view.count(b'CONFIRM Apply this exact preview?') >= (1 if step==2 else 2):os.write(master,b'yes\n');step+=1
  elif step==5 and b'Run this exact command? [y/N]' in view:
   assert b'Proposed check: python3 check.py' in view and (workspace/'first.txt').read_text()=='first new\n' and (workspace/'second.txt').read_text()=='second new\n' and not (workspace/'ran.txt').exists()
   os.write(master,b'yes\n');step=6
  elif step==6 and '检查通过，退出码 0'.encode() in view:
   assert (workspace/'ran.txt').read_text()=='1';os.write(master,b'/events\n');step=7
  elif step==7 and b'independent-check' in view:os.write(master,b'/exit\n');step=8
 while select.select([master],[],[],0)[0]:
  try:
   data=os.read(master,65536)
   if not data:break
   log.extend(data)
  except OSError:break
 (out/'terminal.log').write_bytes(log)
 assert proc.returncode==0 and step==8 and server.seen==list(range(30)),(proc.returncode,step,server.error,server.seen,bytes(log)[-2500:])
 assert (workspace/'ran.txt').read_text()=='1' and b'work-boundary' in log and b'independent-check' in log
 identifier=re.search(rb'SESSION ID ([0-9a-f]{32})',log).group(1).decode()
 status=subprocess.run([str(project/'scripts/nomo'),'--id',identifier,'--status'],env=env,capture_output=True,timeout=120);(out/'status.log').write_bytes(status.stdout+status.stderr)
 assert status.returncode==0,status.stderr
 views=[json.loads(line[len(b'EVENT VIEW '):]) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')];v=views[0]
 assert v['work_phase']=='complete' and v['followup_phase']=='complete' and v['work_settled_calls']==7 and v['followup_settled_calls']==7 and v['work_settled_tokens']==286720 and v['followup_settled_tokens']==286720,v
 print(json.dumps({'status':'passed','scope':'one request; two existing-file previews and confirmations; one check; recorded results and budgets','fake_http':len(server.seen),'result_dir':str(out)}))
except Exception as error:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','step':step,'error':repr(error),'server_error':server.error,'phases':server.seen,'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-4000:]}));raise
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
 os.close(master);server.shutdown();server.server_close()
