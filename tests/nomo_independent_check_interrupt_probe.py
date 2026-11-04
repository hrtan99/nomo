#!/usr/bin/env python3
"""Interrupt one offline independent check and explicitly continue the same session."""
import json,os,pty,re,select,signal,subprocess,tempfile,termios,time
from pathlib import Path
root=Path(__file__).resolve().parent.parent
out=Path(tempfile.mkdtemp(prefix='nomo-interrupted-check-',dir='/private/tmp'));workspace=out/'workspace';workspace.mkdir(mode=0o700)
(workspace/'note.txt').write_text('synthetic\n')
(workspace/'check.py').write_text('import pathlib,time\np=pathlib.Path("ran.txt")\nwith p.open("a") as f: f.write("ran\\n")\ntime.sleep(55)\n')
sessions=out/'sessions';sessions.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
(policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');(policy/'policy.json').chmod(0o600);(policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
env={'PATH':'/Applications/Docker.app/Contents/Resources/bin:'+os.environ['PATH'],'HOME':os.environ['HOME'],'NOMO_ETAS_VERSION':'0.2.6','NOMO_ETAS_GRAPH':'026-v68'}
command=[str(root/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--new','--root',str(workspace),'--allow','note.txt','--events-policy-dir',str(policy)]
master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
process=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
log=bytearray();step=0;deadline=time.monotonic()+180
try:
 while process.poll() is None:
  if time.monotonic()>deadline:raise TimeoutError('step '+str(step))
  if select.select([master],[],[],.1)[0]:
   try:
    data=os.read(master,65536)
    if data:log.extend(data);(out/'terminal.log').write_bytes(log)
   except OSError:pass
  view=bytes(log)
  if step==0 and b'nomo> ' in view:os.write(master,b'/check python3 check.py\n');step=1
  elif step==1 and b'Automatic check for future natural edits:' in view:os.write(master,b'/check --run\n');step=2
  elif step==2 and (workspace/'ran.txt').exists():os.kill(process.pid,signal.SIGINT);step=3
  elif step==3 and b'Continue this session? [y/N]' in view:
   assert (workspace/'ran.txt').read_text()=='ran\n';os.write(master,b'yes\n');step=4
  elif step==4 and view.count(b'nomo> ')>=3:os.write(master,b'/exit\n');step=5
 while select.select([master],[],[],0)[0]:
  try:
   data=os.read(master,65536)
   if not data:break
   log.extend(data)
  except OSError:break
 (out/'terminal.log').write_bytes(log)
 assert process.returncode==0 and step==5,(process.returncode,step,bytes(log)[-3500:])
 assert (workspace/'ran.txt').read_text()=='ran\n' and b'outcome may not be recorded' in log and b'INDEPENDENT CHECK SAVED' not in log
 identifier=re.search(rb'SESSION ID ([0-9a-f]{32})',log).group(1).decode()
 status=subprocess.run([str(root/'scripts/nomo-read.sh'),'session-id','status','--sessions-dir',str(sessions),'--id',identifier,'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
 (out/'status.log').write_bytes(status.stdout+status.stderr);assert status.returncode==0,status.stderr
 print(json.dumps({'status':'passed','scope':'one interrupted offline check; explicit continue; no repeat; same session','result_dir':str(out)}))
except Exception as error:
 (out/'terminal.log').write_bytes(log);print(json.dumps({'status':'failed','step':step,'error':repr(error),'result_dir':str(out),'tail':bytes(log).decode('utf8','replace')[-4000:]}));raise
finally:
 if process.poll() is None:os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=25)
 os.close(master)
