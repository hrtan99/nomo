#!/usr/bin/env python3
"""Exercise one interactive natural-language edit and same-ID continuation."""
import json, os, pty, re, select, shutil, signal, stat, subprocess, tempfile, termios, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ['context.txt', 'second.txt', 'third.txt', 'note.txt']
TASK = '请把 note.txt 中的 old 改为 green'
BEFORE = 'before old\n'
AFTER = BEFORE.replace('before old\n', 'before green\n')

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            ctx = json.loads(req['messages'][1]['content']); i = len(self.server.phases)
            if i in (0, 3, 11, 14): assert req.get('max_tokens') == 4096, ('parent max_tokens', i, req.get('max_tokens'))
            if i == 0:
                assert ctx['current']['request'] == TASK and set(ctx['current']['allowed']) == set(FILES)
                value = ['delegate', 'Read note.txt to identify the requested edit']
            elif i in (1, 5, 12): value = ['read', 'note.txt']
            elif i in (2, 6, 13):
                data = json.dumps(ctx, ensure_ascii=False);assert ('before green' if i == 13 else 'before old') in data
                value = ['final', 'note.txt contains the relevant color']
            elif i == 3: value = 'EDIT note.txt'
            elif i == 4:
                assert ctx['current']['request'] == TASK and ctx['previous']['answer'] == 'EDIT note.txt'
                value = ['delegate', 'Read note.txt before editing']
            elif i == 7: value = 'note.txt contains before old'
            elif i == 8:
                assert ctx['current']['edit']['path'] == 'note.txt' and ctx['current']['edit']['before'] == BEFORE
                value = ['delegate', 'Replace old with green']
            elif i == 9: value = ['edit', 'old', 'green']
            elif i == 10: value = '已将 old 改为 green'
            elif i == 11:
                assert 'id' in ctx['work']
                value = ['delegate', 'Read note.txt to report its current color']
            elif i == 14: value = '当前内容是 before green'
            else: raise AssertionError('unexpected request')
            content = json.dumps(value, ensure_ascii=False, separators=(',', ':')) if isinstance(value, list) else value
            body = json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}], 'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}},ensure_ascii=False).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except Exception as error:
            self.server.failure = repr(error);self.send_error(500)

def interactive(command, env, question, editing):
    master, slave = pty.openpty(); settings = termios.tcgetattr(slave); settings[3] &= ~(termios.ECHO | termios.ECHONL); termios.tcsetattr(slave, termios.TCSANOW, settings)
    proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True);os.close(slave)
    output = bytearray();asked = native = application = exited = False;deadline = time.monotonic() + 240
    try:
        while proc.poll() is None:
            if time.monotonic() > deadline: raise TimeoutError('interactive flow timeout')
            if select.select([master], [], [], .1)[0]:
                try: output.extend(os.read(master, 65536))
                except OSError: pass
            text = bytes(output)
            if not asked and b'nomo> ' in text: os.write(master, question.encode()+b'\n');asked = True
            if editing and not native and b'Type `yes` to approve:' in text:
                previews = [line.removeprefix(b'PREVIEW ') for line in text.splitlines() if line.startswith(b'PREVIEW ')]
                assert len(previews)==1; preview=json.loads(previews[0]);assert preview['path']=='note.txt' and preview['before']==BEFORE and preview['after']==AFTER
                os.write(master,b'yes\n');native=True
            if editing and not application and b'CONFIRM Apply this exact preview? [y/N]' in text:
                assert native;os.write(master,b'yes\n');application=True
            done = b'Check passed.' in text if editing else '当前内容是 before green'.encode() in text
            if done and not exited: os.write(master,b'/exit\n');exited=True
        while select.select([master],[],[],0)[0]:
            try: data=os.read(master,65536)
            except OSError: break
            if not data: break
            output.extend(data)
        if proc.returncode: raise AssertionError('interactive exited '+str(proc.returncode)+'; '+bytes(output).decode('utf-8','replace')[-3000:])
        assert asked and exited and (not editing or (native and application))
        return bytes(output)
    finally:
        if proc.poll() is None: os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
        os.close(master)

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-natural-work-'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'));(project/'.etas').mkdir(mode=0o700)
    workspace=out/'workspace';mask=os.umask(0o022)
    try: workspace.mkdir(mode=0o755)
    finally: os.umask(mask)
    assert stat.S_IMODE(workspace.stat().st_mode)==0o755
    for name in FILES:(workspace/name).write_text(BEFORE if name=='note.txt' else 'unrelated context\n')
    sessions=out/'sessions';sessions.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text(json.dumps({'format':1,'literals':['SYNTHETIC_NEVER_PRESENT']}));(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failure=None
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text)
        env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.6'}
        command=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--new','--root',str(workspace),'--allow',','.join(FILES),'--events-policy-dir',str(policy),'--check','/bin/sh','-c','grep -qx "before green" note.txt']
        first=interactive(command,env,TASK,True);match=re.search(rb'SESSION ID ([0-9a-f]{32})',first);assert match
        assert (workspace/'note.txt').read_text()==AFTER and all((workspace/f).read_text()=='unrelated context\n' for f in FILES[:-1])
        assert stat.S_IMODE(workspace.stat().st_mode)==0o755
        command=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(sessions),'--id',match.group(1).decode(),'--root',str(workspace),'--allow',','.join(FILES),'--events-policy-dir',str(policy)]
        resume=subprocess.run(command+['--once','现在文件的颜色是什么？'],env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=180)
        second=resume.stdout
        assert resume.returncode == 0, (resume.returncode, resume.stdout[-3000:], resume.stderr[-1000:])
        assert not server.failure and server.phases==list(range(15));assert '当前内容是 before green'.encode() in second
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','status','--sessions-dir',str(sessions),'--id',match.group(1).decode(),'--events','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        assert status.returncode==0 and b'before old' in status.stdout and b'before green' in status.stdout
        print(json.dumps({'status':'passed','scope':'new session 4096 parent requests; noninteractive post-edit exact-ID continuation','file_bytes':len(BEFORE.encode()),'fake_requests':len(server.phases),'confirmations':2,'selected_file':'note.txt','unchanged_other_files':3}))
    finally:server.shutdown();server.server_close();thread.join(timeout=5);shutil.rmtree(out)

if __name__=='__main__':main()
