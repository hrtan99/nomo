#!/usr/bin/env python3
"""Signal only the parent while a fake model request is blocked; inspect cleanup."""
import json,os,signal,shutil,sqlite3,subprocess,tempfile,threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        self.server.count+=1;self.rfile.read(int(self.headers['Content-Length']));self.server.started.set();self.server.release.wait(35)
        try:self.send_response(503);self.send_header('Content-Length','0');self.end_headers()
        except (BrokenPipeError,ConnectionResetError):pass

def container_absent(context):
    listing=subprocess.run(['docker','ps','-aq','--filter','label=nomo.terminal.invocation'],capture_output=True,check=True,timeout=10)
    for ident in listing.stdout.splitlines():
        c=subprocess.run(['docker','inspect','--format','{{json .Mounts}}',ident.decode()],capture_output=True,timeout=10)
        if c.returncode:
            if b'No such object' in c.stderr or b'No such container' in c.stderr:continue
            return False
        mounts={x['Destination']:x for x in json.loads(c.stdout)}
        if mounts.get('/model-tool-fixture',{}).get('Source') in (str(context),'/host_mnt'+str(context)):return False
    return True

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-session-interrupt-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n');state=out/'state';state.mkdir(mode=0o700)
    server=HTTPServer(('127.0.0.1',0),Fake);server.count=0;server.started=threading.Event();server.release=threading.Event()
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();proc=None
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-session-new','nomo-read-session-existing'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY'}
        def cmd(action):return [str(project/'scripts/nomo-read.sh'),action,'--root',str(context),'--state',str(state),'--allow','context.txt','--once','Read the color']
        proc=subprocess.Popen(cmd('session-new'),env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        assert server.started.wait(60) and proc.poll() is None
        proc.send_signal(signal.SIGTERM);stdout,stderr=proc.communicate(timeout=30);server.release.set()
        (out/'first.stdout').write_bytes(stdout);(out/'first.stderr').write_bytes(stderr)
        assert proc.returncode==143 and b'Cancellation was requested.' in stderr and container_absent(context)
        db=state/'history.sqlite3'
        with sqlite3.connect(db) as c:
            before=list(c.iterdump());row=json.loads(c.execute("select value_json from memory_entries where region='nomo-chat-history-v1'").fetchone()[0]);phase=next(x['value']['value'] for x in row['fields'] if x['name']=='phase');assert phase=='running'
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120)
        assert status.returncode==0 and b'SESSION running turns=0' in status.stdout
        second=subprocess.run(cmd('session-continue'),env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=120)
        (out/'second.stdout').write_bytes(second.stdout);(out/'second.stderr').write_bytes(second.stderr)
        assert second.returncode!=0 and b'REFUSED' in second.stdout and server.count==1
        with sqlite3.connect(db) as c:assert list(c.iterdump())==before
        assert container_absent(context)
        result={'status':'passed','scope':'parent PID SIGTERM during local fake provider request','model_requests':server.count,'parent_exit':proc.returncode,
                'owned_container_absent':True,'running_retained':True,'offline_status_checked':True,'second_dispatch_refused':True,'logical_state_unchanged':True}
    except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'model_requests':server.count,'parent_exit':proc.poll() if proc else None}
    finally:
        server.release.set()
        if proc and proc.poll() is None:proc.kill();proc.communicate(timeout=10)
        server.shutdown();server.server_close();thread.join(timeout=5)
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
