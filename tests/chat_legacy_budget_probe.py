#!/usr/bin/env python3
"""Exercise a prior-format session through old and new product trees."""
import json, os, re, shutil, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

NEW = Path(__file__).resolve().parent.parent
if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--wide'):
    raise SystemExit('usage: chat_legacy_budget_probe.py OLD_PROJECT [--wide]')
OLD = Path(sys.argv[1]).resolve(strict=True)
WIDE = len(sys.argv) == 3

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            i = len(self.server.seen)
            expected = 4096 if WIDE else (2048 if i % 4 in (0, 3) else 4096)
            assert req['max_tokens'] == expected, (i, req.get('max_tokens'))
            value = (['delegate','Read note.txt'] if i % 4 == 0 else
                     ['read','note.txt'] if i % 4 == 1 else
                     ['final','The file says before old'] if i % 4 == 2 else 'The file says before old')
            content = json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}}).encode()
            self.server.seen.append(i);self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception as error:
            self.server.failure=repr(error);self.send_error(500)

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-legacy-budget-',dir='/private/tmp'))
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n')
    sessions=out/'sessions';sessions.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.seen=[];server.failure=None
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    try:
        projects=[]
        for name,source in [('old',OLD),('new',NEW)]:
            project=out/name;shutil.copytree(source,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir()
            manifest=project/'etas.toml';text=manifest.read_text()
            for profile in ('nomo-read-events-new','nomo-read-events-existing'):
                start=text.index('[runtime.profiles.'+profile+'.model]');end=text.index('[runtime.profiles.'+profile+'.model.timeout]',start)
                part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
            manifest.write_text(text);projects.append(project)
        env={k:os.environ[k] for k in ('PATH','HOME','LANG') if k in os.environ};env.update(MINIMAX_API_KEY='SYNTHETIC_ONLY',NOMO_ETAS_VERSION='0.2.6',NOMO_ETAS_GRAPH='026-v68')
        env['PATH'] = '/Applications/Docker.app/Contents/Resources/bin:' + env.get('PATH', '')
        def run(project,action,identifier=None):
            cmd=[str(project/'scripts/nomo-read.sh'),'session-id',action,'--sessions-dir',str(sessions),'--root',str(workspace),'--allow','note.txt','--once','Read note.txt','--events-policy-dir',str(policy)]
            if identifier:cmd+=['--id',identifier]
            return subprocess.run(cmd,env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=180)
        first=run(projects[0],'start');(out/'old.log').write_bytes(first.stdout+first.stderr)
        ids=re.findall(rb'(?m)^SESSION ID ([0-9a-f]{32})\r?$',first.stdout)
        assert first.returncode==0 and len(ids)==1 and b'SAVED chat' in first.stdout,(first.returncode,server.failure)
        second=run(projects[1],'resume',ids[0].decode());(out/'new.log').write_bytes(second.stdout+second.stderr)
        assert second.returncode==0 and b'SAVED chat' in second.stdout and server.seen==list(range(8)),(second.returncode,server.failure,server.seen)
        assert (b'tokens=32768' if WIDE else b'tokens=14336') in second.stdout, 'legacy cumulative token ledger did not persist'
        print(json.dumps({'status':'passed','scope':'old-format session resumed by new candidate with its original parent allowance and retained ledger','fake_requests':len(server.seen),'result_dir':str(out)}))
    finally:server.shutdown();server.server_close();worker.join(timeout=5)
if __name__=='__main__':main()
