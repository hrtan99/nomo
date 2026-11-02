#!/usr/bin/env python3
import json,os,signal,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent;OUT=Path(tempfile.mkdtemp(prefix='nomo-terminal-handshake-',dir='/private/tmp'));results=[]
def docker_empty():
 r=subprocess.run(['/usr/local/bin/docker','ps','-aq','--filter','label=nomo.terminal.invocation'],capture_output=True,timeout=10);return r.returncode==0 and not r.stdout.strip()
def execute(name,shell,interrupt=None,inspection_failure=False,early=False):
 ws=OUT/name;ws.mkdir(mode=0o700);env=dict(os.environ,NOMO_ETAS_VERSION='0.2.5');shim=OUT/'bin'
 if inspection_failure or early:
  shim.mkdir(exist_ok=True);docker=shim/'docker';docker.write_text('#!/bin/sh\nif [ "$1" = inspect ]; then '+('sleep 2; ' if early else '')+'echo synthetic-inspection-unavailable >&2; exit 1; fi\nexec /usr/local/bin/docker "$@"\n');docker.chmod(0o700);env['PATH']=str(shim)+':'+env['PATH']
 cmd=[str(ROOT/'scripts/nomo-read.sh'),'check','--root',str(ws),'--','/bin/sh','-c',shell];p=subprocess.Popen(cmd,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try:
  if interrupt:
   until=time.monotonic()+25
   if early:time.sleep(.2)
   else:
    while not (ws/'started').exists():
     if p.poll() is not None or time.monotonic()>until:raise RuntimeError('check did not start')
     time.sleep(.02)
   p.send_signal(interrupt)
  out,err=p.communicate(timeout=45)
 finally:
  if p.poll() is None:
   try:
    os.killpg(p.pid,signal.SIGTERM)
    try:p.wait(timeout=25)
    except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
   except ProcessLookupError:pass
 result={'case':name,'exit':p.returncode,'side_effect':(ws/'started').exists(),'unconfirmed':b'cleanup is unconfirmed' in out+err,'process_stopped':p.poll() is not None,'no_labelled_containers_after':docker_empty()}
 results.append(result);print(json.dumps(result),flush=True)
 (OUT/(name+'.stdout')).write_bytes(out);(OUT/(name+'.stderr')).write_bytes(err)
 if name in ('success','stdin_eof'):assert p.returncode==0 and result['side_effect']
 if name=='failure':assert p.returncode==7 and result['side_effect']
 if name=='sigint':assert p.returncode==130 and result['side_effect'] and not result['unconfirmed']
 if name=='sigterm':assert p.returncode==143 and result['side_effect'] and not result['unconfirmed']
 if name in ('inspection_failure','early_interrupt'):assert p.returncode==125 and result['unconfirmed'] and not result['side_effect']
 assert result['no_labelled_containers_after']
try:
 execute('success','touch started; exit 0')
 execute('stdin_eof','if IFS= read -r line; then exit 9; else touch started; fi')
 execute('failure','touch started; exit 7')
 execute('sigint','touch started; sleep 30',signal.SIGINT)
 execute('sigterm','touch started; sleep 30',signal.SIGTERM)
 execute('inspection_failure','touch started; sleep 30',inspection_failure=True)
 execute('early_interrupt','touch started; sleep 30',signal.SIGINT,early=True)
 status='passed'
except BaseException as e:
 results.append({'error':type(e).__name__});status='failed'
(OUT/'result.json').write_text(json.dumps({'status':status,'cases':results},indent=2)+'\n');print(json.dumps({'status':status,'evidence':str(OUT)}),flush=True);raise SystemExit(0 if status=='passed' else 1)
