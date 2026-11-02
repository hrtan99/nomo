#!/usr/bin/env python3
"""A failed synthetic model call must leave a durable, non-replayed reservation."""
import json,os,shutil,sqlite3,subprocess,tempfile,threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        self.server.count+=1
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(503);self.send_header('Content-Length','0');self.end_headers()

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-session-fault-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    state=out/'state';state.mkdir(mode=0o700)
    server=HTTPServer(('127.0.0.1',0),Fake);server.count=0;thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-session-new','nomo-read-session-existing'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true')
            text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY'}
        def run(action):
            return subprocess.run([str(project/'scripts/nomo-read.sh'),action,'--root',str(context),'--state',str(state),'--allow','context.txt','--once','Read the color'],env=env,capture_output=True,timeout=120)
        first=run('session-new');(out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
        assert first.returncode!=0 and b'RESERVED chat turn' in first.stdout and server.count==1
        db=state/'history.sqlite3'
        with sqlite3.connect(db) as c:
            before=list(c.iterdump());row=json.loads(c.execute("select value_json from memory_entries where region='nomo-chat-history-v1'").fetchone()[0]);phase=next(x['value']['value'] for x in row['fields'] if x['name']=='phase');assert phase=='running'
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        assert status.returncode==0 and b'SESSION running turns=0' in status.stdout and server.count==1
        second=run('session-continue');(out/'second.stdout').write_bytes(second.stdout);(out/'second.stderr').write_bytes(second.stderr)
        assert second.returncode!=0 and b'REFUSED' in second.stdout and server.count==1
        with sqlite3.connect(db) as c:assert list(c.iterdump())==before
        result={'status':'passed','scope':'synthetic provider 503, not process-kill or real-model outcome','model_requests':server.count,'running_retained':True,'offline_status_checked':True,'second_dispatch_refused':True,'logical_state_unchanged':True}
    except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'model_requests':server.count}
    finally:server.shutdown();server.server_close();thread.join(timeout=5)
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
