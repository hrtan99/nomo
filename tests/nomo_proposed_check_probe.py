#!/usr/bin/env python3
"""Local fake-model check proposal: deny, approve, record failure, then resume."""
import json, os, pty, re, select, shutil, signal, subprocess, tempfile, termios, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
TASK='请运行 check.py 并报告检查结果。'
FOLLOW='刚才检查的结果是什么？'
CHECK="from pathlib import Path\np=Path('ran.txt')\np.write_text(str(int(p.read_text())+1) if p.exists() else '1')\nprint('SYNTHETIC_FAIL_42')\nraise SystemExit(3)\n"

class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.phases)
            if i==0:
                assert ctx['current']['request']==TASK
                value=['delegate','Read check.py to identify the requested check']
            elif i==1:value=['read','check.py']
            elif i==2:value=['final','check.py is the requested test']
            elif i==3:value='CHECK python3 check.py'
            elif i==4:
                assert ctx['current']['request']==FOLLOW
                checks=[e for e in ctx['history'] if e['role']=='tool' and e['kind']=='check' and e['name']=='independent-check']
                assert len(checks)==1 and 'SYNTHETIC_FAIL_42' in checks[0]['text'] and 'Exit 3' in checks[0]['text']
                value=['delegate','Read check.py and summarize the recorded check']
            elif i==5:value=['read','check.py']
            elif i==6:value=['final','The test script is check.py']
            elif i==7:value='检查失败，退出码 3，输出 SYNTHETIC_FAIL_42。'
            else:raise AssertionError('unexpected model request')
            content=json.dumps(value,ensure_ascii=False,separators=(',',':')) if isinstance(value,list) else value
            body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}},ensure_ascii=False).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except Exception as exc:self.server.failure=repr(exc);self.send_error(500)


def run_case(project,server,out,approve):
    workspace=out/'workspace';workspace.mkdir(mode=0o755);(workspace/'check.py').write_text(CHECK)
    env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6','NOMO_ETAS_GRAPH':'026-v68','NOMO_STATE_DIR':str(out/'state')}
    command=[str(project/'scripts/nomo'),'--root',str(workspace),'--allow','check.py']
    master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
    proc=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
    output=bytearray();asked=confirmed=continued=events=exited=False;deadline=time.monotonic()+240
    try:
        while proc.poll() is None:
            if time.monotonic()>deadline:raise TimeoutError('check proposal flow timeout')
            if select.select([master],[],[],.1)[0]:
                try:output.extend(os.read(master,65536))
                except OSError:pass
            text=bytes(output)
            if not asked and b'nomo> ' in text:os.write(master,TASK.encode()+b'\n');asked=True
            if not confirmed and b'Run this exact command? [y/N]' in text:
                assert b'Proposed check: python3 check.py' in text and not (workspace/'ran.txt').exists()
                os.write(master,b'y\n' if approve else b'n\n');confirmed=True
            if confirmed and not approve and not exited and b'Check declined; no command was run.' in text:
                assert not (workspace/'ran.txt').exists();os.write(master,b'/exit\n');exited=True
            if approve and not continued and b'Check failed (exit 3)' in text and b'Recorded check output is available' in text:
                assert (workspace/'ran.txt').read_text()=='1';os.write(master,FOLLOW.encode()+b'\n');continued=True
            if continued and not events and '检查失败，退出码 3'.encode() in text:os.write(master,b'/events\n');events=True
            if events and not exited and b'independent-check' in text:os.write(master,b'/exit\n');exited=True
        if proc.returncode:raise AssertionError('process failed '+str(proc.returncode)+' '+bytes(output).decode('utf-8','replace')[-4000:])
        assert asked and confirmed and exited and (not approve or (continued and events))
        assert not server.failure,server.failure
        if approve:assert server.phases==list(range(8)) and (workspace/'ran.txt').read_text()=='1'
        else:assert server.phases==list(range(4)) and not (workspace/'ran.txt').exists()
    finally:
        if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
        os.close(master)


def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-proposed-check-'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'));(project/'.etas').mkdir(mode=0o700)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failure=None
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text)
        denied=out/'denied';denied.mkdir();run_case(project,server,denied,False)
        server.phases=[];server.failure=None
        approved=out/'approved';approved.mkdir();run_case(project,server,approved,True)
        print(json.dumps({'status':'passed','denied_no_execution':True,'approved_once':True,'recorded_exit':3,'recorded_output':'SYNTHETIC_FAIL_42','later_model_saw_check':True,'evidence':str(out)}))
    finally:server.shutdown();server.server_close();thread.join(timeout=5)

if __name__=='__main__':main()
