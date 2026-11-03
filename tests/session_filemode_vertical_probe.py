#!/usr/bin/env python3
"""Observe live and resumed SQLite mode bits with a synthetic provider."""
import json,os,shutil,signal,stat,subprocess,tempfile,threading
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class Fake(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def do_POST(self):
  try:
   assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY';req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));assert req['max_tokens']==2048;i=len(self.server.phases)
   if i==0:
    self.server.started.set();assert self.server.release.wait(60);value=['delegate','Read context.txt']
   elif i==1:value=['read','context.txt']
   elif i==2:value=['final','blue']
   elif i==3:value='blue'
   else:raise ValueError('unexpected model call')
   content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value;raw=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
   self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
  except Exception:
   self.server.failed=True
   try:self.send_error(500)
   except OSError:pass

def mode_files(state):
 return {p.name:stat.S_IMODE(p.stat().st_mode) for p in state.glob('history.sqlite3*') if p.is_file() and not p.is_symlink()}
def main():
 out=Path(tempfile.mkdtemp(prefix='nomo-session-filemode-',dir='/private/tmp'));project=out/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','__pycache__'));ctx=out/'context';ctx.mkdir(mode=0o700);(ctx/'context.txt').write_text('blue\n');state=out/'state';state.mkdir(mode=0o700)
 server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;server.started=threading.Event();server.release=threading.Event();thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();proc=None
 try:
  p=project/'etas.toml';text=p.read_text();name='nomo-read-session-new';start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start);block=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');p.write_text(text[:start]+block+text[end:])
  env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY'};cmd=[str(project/'scripts/nomo-read.sh'),'session-new','--root',str(ctx),'--state',str(state),'--allow','context.txt','--once','Read the word']
  proc=subprocess.Popen(cmd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  assert server.started.wait(90);live=mode_files(state);assert {'history.sqlite3','history.sqlite3-wal','history.sqlite3-shm'}<=set(live) and all(x==0o600 for x in live.values()),str(live)
  server.release.set();stdout,stderr=proc.communicate(timeout=120);assert proc.returncode==0 and b'FINAL blue' in stdout and server.phases==list(range(4)) and not server.failed
  after=mode_files(state);assert all(x==0o600 for x in after.values())
  for p in state.glob('history.sqlite3*'):
   if p.is_file():p.chmod(0o644)
  status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120);assert status.returncode==0 and b'SESSION ready turns=1' in status.stdout
  repaired=mode_files(state);assert all(x==0o600 for x in repaired.values())
  result={'status':'passed','scope':'mode bits for new and legacy SQLite session files; not content redaction or ACL audit','live_modes':{k:oct(v) for k,v in live.items()},'after_modes':{k:oct(v) for k,v in after.items()},'repaired_modes':{k:oct(v) for k,v in repaired.items()},'fake_requests':4,'session_preserved':True}
 except BaseException as error:result={'status':'failed','failure_type':type(error).__name__,'phases':server.phases,'detail':str(error) if isinstance(error,AssertionError) else ''}
 finally:
  server.release.set()
  if proc and proc.poll() is None:
   os.killpg(proc.pid,signal.SIGTERM)
   try:proc.wait(timeout=20)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
  server.shutdown();server.server_close();thread.join(timeout=5)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
