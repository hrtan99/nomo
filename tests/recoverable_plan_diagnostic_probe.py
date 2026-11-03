#!/usr/bin/env python3
"""Probe real session entry with local synthetic model responses; save no response text."""
import json, os, re, shutil, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        index=self.server.calls; self.server.calls+=1
        if self.server.mode=='http503':
            self.send_error(503);return
        values={'success':['["delegate","Read context.txt"]','["read","context.txt"]','["final","blue"]','blue'],
                'frame':['synthetic invalid framing'], 'json':['["delegate","task",]'],
                'task':['["other","task"]']}
        content=values[self.server.mode][index]
        body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                         'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-chat-diagnostic-'))
    project=out/'project';shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'))
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text(json.dumps({'format':1,'literals':['SYNTHETIC_SECRET']}));(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    manifest=project/'etas.toml';text=manifest.read_text()
    for name in ('nomo-read-events-new','nomo-read-events-existing'):
        start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
        part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true')
        text=text[:start]+part+text[end:]
    manifest.write_text(text)
    env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY'}
    observed={}
    try:
        for mode in ('success','frame','json','task','http503'):
            server.mode=mode;server.calls=0
            registry=out/('sessions-'+mode);registry.mkdir(mode=0o700)
            cmd=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(registry),'--new',
                 '--root',str(context),'--allow','context.txt','--once','Read the color','--events-policy-dir',str(policy)]
            run=subprocess.run(cmd,env=env,capture_output=True,timeout=180)
            combined=run.stdout+b'\n'+run.stderr
            if (mode=='success' and run.returncode!=0) or (mode!='success' and run.returncode!=3):
                print(json.dumps({'mode':mode,'exit':run.returncode,'requests':server.calls,'synthetic_tail':combined[-3000:].decode('utf-8','replace')}),flush=True)
            expected={'frame':b'text_marker=bounded_json_frame_refused','json':b'text_marker=invalid_json_refused',
                      'task':b'text_marker=delegated_task_refused','http503':b'text_marker=provider_http_503'}
            if mode=='success':assert run.returncode==0 and server.calls==4 and b'FINAL blue' in combined
            else:
                assert run.returncode==3 and server.calls==1 and expected[mode] in combined
                assert b'last_stage_text=chat-plan' in combined and b'Resume interactive:' not in combined
                assert len(re.findall(rb'^SESSION ID [0-9a-f]{32}\r?$',run.stdout,re.MULTILINE))==1
            observed[mode]={'exit':run.returncode,'requests':server.calls,'classified':mode=='success' or expected[mode] in combined}
        assert (context/'context.txt').read_text()=='blue\n'
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5);shutil.rmtree(out)
    print(json.dumps({'status':'passed','scope':'synthetic local provider; no real provider or session replay','cases':observed}))

if __name__=='__main__':main()
