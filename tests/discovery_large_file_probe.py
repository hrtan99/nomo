#!/usr/bin/env python3
"""Search a medium-sized synthetic source file through the real discovery route."""
import json, os, shutil, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = Path(tempfile.mkdtemp(prefix='nomo-large-search-', dir='/private/tmp'))
project = out/'project'
shutil.copytree(root, project, ignore=shutil.ignore_patterns('.git', '.etas', 'tmp', '__pycache__'))
(project/'.etas').mkdir()
workspace = out/'workspace'; workspace.mkdir(mode=0o700)
budget_case = os.environ.get('NOMO_PROBE_BUDGET') == '1'
target = 'a-target.txt' if budget_case else 'target.txt'
(workspace/target).write_text('padding\n'*3000+'UNIQUE_SEARCH_NEEDLE\n')
for i in range(70 if budget_case else 1):
    (workspace/('z-overflow%02d.txt'%i if budget_case else 'overflow.txt')).write_text('x'*70000)
(workspace/'small.txt').write_text('unrelated\n')

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        try:
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            context=json.loads(request['messages'][1]['content']); phase=len(self.server.seen)
            if phase==0: value=['delegate','Search all discovered files for the requested unique marker']
            elif phase==1: value=['search','UNIQUE_SEARCH_NEEDLE','*']
            elif phase==2:
                text=json.dumps(context,ensure_ascii=False)
                assert target+':3001' in text and 'overflow' in text, text
                assert ('scan allowance exhausted' if budget_case else 'skipped 1') in text, text
                value=['final','Found the marker on line 3001; oversized files were skipped']
            elif phase==3: value='Found '+target+':3001; oversized files were skipped.'
            else: raise ValueError('unexpected model request')
            content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
            self.server.seen.append(phase);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except Exception as error:
            self.server.error=repr(error);self.send_error(500)

server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.error=None
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
    manifest=project/'etas.toml';text=manifest.read_text().replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');manifest.write_text(text)
    env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6','NOMO_ETAS_GRAPH':'026-v68','NOMO_STATE_DIR':str(out/'state')}
    run=subprocess.run([str(project/'scripts/nomo'),'--root',str(workspace),'--once','Find the unique marker in the project.'],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
    (out/'terminal.log').write_bytes(run.stdout)
    assert run.returncode==0 and server.seen==list(range(4)) and server.error is None,(run.returncode,server.seen,server.error,run.stdout[-2500:])
    assert (target+':3001').encode() in run.stdout and b'Search incomplete' in run.stdout
    print(json.dumps({'status':'passed','budget_case':budget_case,'target_bytes':(workspace/target).stat().st_size,'oversized_bytes':70000,'local_requests':len(server.seen),'evidence':str(out)}))
finally:
    server.shutdown();server.server_close();thread.join(timeout=5)
