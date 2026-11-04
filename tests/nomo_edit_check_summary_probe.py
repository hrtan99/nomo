#!/usr/bin/env python3
"""Confirm an edit, fail its configured check, and automatically summarize it."""
import json, os, pty, re, select, shutil, signal, subprocess, tempfile, termios, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
TASK='请将 note.txt 中的 old 改成 new。'
BEFORE='before old\n';AFTER='before new\n'
CHECK="from pathlib import Path\np=Path('runs.txt')\np.write_text(str(int(p.read_text())+1) if p.exists() else '1')\nprint('CHECK_FAILURE_TOKEN')\nraise SystemExit(3)\n"

class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.phases)
            if i==0:value=['delegate','Read note.txt to identify the requested edit']
            elif i in (1,5,12):value=['read','note.txt']
            elif i in (2,6,13):value=['final','note.txt contains the relevant value']
            elif i==3:value='EDIT note.txt'
            elif i==4:value=['delegate','Read note.txt before editing']
            elif i==7:value='The current text contains old'
            elif i==8:value=['delegate','Replace old with new']
            elif i==9:value=['edit','old','new']
            elif i==10:value='已将 old 改为 new。'
            elif i==11:
                checks=[e for e in ctx['history'] if e['role']=='tool' and e['kind']=='check' and e['name']=='work-check']
                assert len(checks)==1 and 'CHECK_FAILURE_TOKEN' in checks[0]['text'] and 'Outcome failed. Exit 3' in checks[0]['text']
                identifier=re.search(r'Recorded check (auto-[0-9a-f]{16})',checks[0]['text']).group(1)
                assert ctx['current']['request'].startswith('AUTO-CONTINUATION (no new user input):') and identifier in ctx['current']['request']
                assert 'do not claim it passed' in ctx['current']['request']
                value=['delegate','Inspect note.txt and summarize the recorded failure']
            elif i==14:value='检查失败，退出码 3；建议查看 CHECK_FAILURE_TOKEN。'
            else:raise AssertionError('unexpected model request')
            content=json.dumps(value,ensure_ascii=False,separators=(',',':')) if isinstance(value,list) else value
            body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}},ensure_ascii=False).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except Exception as exc:self.server.failure=repr(exc);self.send_error(500)


def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-edit-check-summary-'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'));(project/'.etas').mkdir(mode=0o700)
    workspace=out/'workspace';workspace.mkdir(mode=0o755);(workspace/'note.txt').write_text(BEFORE);(workspace/'verify.py').write_text(CHECK)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failure=None
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    master=slave=None;proc=None
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text)
        env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6','NOMO_ETAS_GRAPH':'026-v68','NOMO_STATE_DIR':str(out/'state')}
        command=[str(project/'scripts/nomo'),'--root',str(workspace),'--allow','note.txt','--check','python3','verify.py']
        master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
        proc=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);slave=None
        output=bytearray();asked=native=application=events=exited=False;deadline=time.monotonic()+240
        while proc.poll() is None:
            if time.monotonic()>deadline:raise TimeoutError('automatic post-edit summary timeout')
            if select.select([master],[],[],.1)[0]:
                try:output.extend(os.read(master,65536))
                except OSError:pass
            data=bytes(output)
            if not asked and b'nomo> ' in data:os.write(master,TASK.encode()+b'\n');asked=True
            if not native and b'Type `yes` to approve:' in data:
                previews=[line.removeprefix(b'PREVIEW ') for line in data.splitlines() if line.startswith(b'PREVIEW ')]
                assert len(previews)==1;value=json.loads(previews[0]);assert value['path']=='note.txt' and value['before']==BEFORE and value['after']==AFTER
                os.write(master,b'yes\n');native=True
            if not application and b'CONFIRM Apply this exact preview? [y/N]' in data:assert native;os.write(master,b'yes\n');application=True
            if not events and '检查失败，退出码 3'.encode() in data:
                assert b'Check failed (exit 3)' in data and (workspace/'runs.txt').read_text()=='1'
                os.write(master,b'/events\n');events=True
            if events and not exited and b'work-check' in data:os.write(master,b'/exit\n');exited=True
        if proc.returncode:raise AssertionError('terminal failed '+str(proc.returncode)+' '+bytes(output).decode('utf-8','replace')[-4000:])
        assert asked and native and application and events and exited and not server.failure,server.failure
        assert server.phases==list(range(15)) and (workspace/'note.txt').read_text()==AFTER and (workspace/'runs.txt').read_text()=='1'
        assert b'AUTO-CONTINUATION (no new user input)' in output and b'work-check' in output
        print(json.dumps({'status':'passed','edit_confirmations':2,'check_exit':3,'check_executions':1,'automatic_model_summary':True,'fake_requests':len(server.phases),'evidence':str(out)}))
    finally:
        if proc and proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
        if master is not None:os.close(master)
        if slave is not None:os.close(slave)
        server.shutdown();server.server_close();thread.join(timeout=5)

if __name__=='__main__':main()
