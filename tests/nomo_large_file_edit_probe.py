#!/usr/bin/env python3
"""Exercise one interactive natural-language edit and same-ID continuation."""
import json, os, pty, re, select, shutil, signal, sqlite3, stat, subprocess, tempfile, termios, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ['context.txt', 'second.txt', 'third.txt', 'note.txt']
TASK = '请把 note.txt 中的 old 改为 new。'
BEFORE = 'padding\n' * 131071 + 'old\nxxxx'
AFTER = BEFORE.replace('old', 'new')
assert len(BEFORE.encode()) == 1048576
DISPLAYED = BEFORE.replace('%', '%%').replace('\n', '%n').replace('\r', '%r').replace('\t', '%t')

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            ctx = json.loads(''.join(message['content'] for message in req['messages'][1:])); i = len(self.server.phases)
            if i == 0:
                assert ctx['current']['request'] == TASK and ctx['current']['allowed'] == FILES
                value = ['delegate', 'Read note.txt to identify the requested edit']
            elif i in (1, 5, 12): value = ['read', 'note.txt']
            elif i in (2, 6, 13): value = ['final', 'note.txt contains the relevant color']
            elif i == 3: value = 'EDIT note.txt'
            elif i == 4:
                assert ctx['current']['request'] == TASK and ctx['previous']['answer'] == 'EDIT note.txt'
                assert ctx['previous']['outcome'] == 'complete: ' + DISPLAYED
                value = ['delegate', 'Read note.txt before editing']
            elif i == 7: value = 'note.txt contains before old'
            elif i == 8:
                assert ctx['current']['edit']['path'] == 'note.txt'
                value = ['delegate', 'Replace old with green']
            elif i == 9: value = ['edit', 'old', 'new']
            elif i == 10: value = '已将 old 改为 new'
            elif i == 11:
                work = ctx['work'];assert work.get('name') == 'Some' and isinstance(work.get('fields'),list) and len(work['fields']) == 1
                evidence = work['fields'][0]['evidence'];fields = evidence.get('fields') if isinstance(evidence,dict) else None
                field = fields[0] if isinstance(fields,list) and len(fields)==1 and isinstance(fields[0],str) else None
                self.server.evidence_matches = evidence == {'name':'Some','fields':['complete: ' + DISPLAYED]}
                self.server.evidence_detail = {'name':evidence.get('name') if isinstance(evidence,dict) else None,
                    'length':None if field is None else len(field),'expected_length':len('complete: '+DISPLAYED),
                    'prefix':None if field is None else field[:40],'suffix':None if field is None else field[-40:]}
                value = ['delegate', 'Read note.txt to report its current color']
            elif i == 14: value = '当前文件包含 new'
            else: raise AssertionError('unexpected request')
            content = json.dumps(value, ensure_ascii=False, separators=(',', ':')) if isinstance(value, list) else value
            body = json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}], 'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}},ensure_ascii=False).encode()
            self.server.phases.append(i)
            print('FAKE_PHASE %d elapsed=%.1fs' % (i, time.monotonic()-self.server.started), flush=True)
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except Exception as error:
            detail = ''
            if 'i' in locals() and i == 11:
                work = ctx.get('work', {});work_fields = work.get('fields') if isinstance(work,dict) else None
                fact = work_fields[0] if isinstance(work_fields,list) and len(work_fields)==1 and isinstance(work_fields[0],dict) else {}
                evidence = fact.get('evidence')
                if isinstance(evidence, dict):
                    fields = evidence.get('fields')
                    field = fields[0] if isinstance(fields, list) and len(fields) == 1 and isinstance(fields[0], str) else None
                    detail = ' evidence_name=%r evidence_length=%r expected_length=%r prefix=%r suffix=%r' % (
                        evidence.get('name'), None if field is None else len(field), len('complete: ' + DISPLAYED),
                        None if field is None else field[:40], None if field is None else field[-40:])
                else: detail = ' evidence=%r' % (evidence,)
            self.server.failure = repr(error) + detail;print('FAKE_FAILURE '+self.server.failure,flush=True);self.send_error(500)

def interactive(command, env, question, editing):
    master, slave = pty.openpty(); settings = termios.tcgetattr(slave); settings[3] &= ~(termios.ECHO | termios.ECHONL); termios.tcsetattr(slave, termios.TCSANOW, settings)
    proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True);os.close(slave)
    output = bytearray();asked = native = application = exited = events_requested = False;deadline = time.monotonic() + 600
    try:
        while proc.poll() is None:
            if time.monotonic() > deadline: raise TimeoutError('interactive flow timeout; '+bytes(output).decode('utf-8','replace')[-3000:])
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
            done = b'Check recorded. The deterministic outcome above is authoritative' in text if editing else '当前文件包含 new'.encode() in text
            if done and not editing and not events_requested: os.write(master,b'/events\n');events_requested=True
            if (editing and done or events_requested and b'TIMELINE ' in text) and not exited: os.write(master,b'/exit\n');exited=True
            if asked and not exited and not events_requested and text.count(b'nomo> ') >= 2:
                raise AssertionError('flow returned to prompt early; '+bytes(output).decode('utf-8','replace')[-3000:])
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
    project.mkdir()
    for name in ('src','scripts','config'):
        shutil.copytree(ROOT/name,project/name,ignore=shutil.ignore_patterns('__pycache__'))
    for name in ('etas.toml','etas.lock','compose.yaml','Dockerfile'):
        shutil.copyfile(ROOT/name,project/name)
    (project/'.etas').mkdir(mode=0o700)
    workspace=out/'workspace';mask=os.umask(0o022)
    try: workspace.mkdir(mode=0o755)
    finally: os.umask(mask)
    assert stat.S_IMODE(workspace.stat().st_mode)==0o755
    for name in FILES:(workspace/name).write_text(BEFORE if name=='note.txt' else 'unrelated context\n')
    sessions=out/'sessions';sessions.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text(json.dumps({'format':1,'literals':['SYNTHETIC_NEVER_PRESENT']}));(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.started=time.monotonic();server.failure=None;server.evidence_matches=False;server.evidence_detail=None
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text)
        env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.4.1','NOMO_STATE_DIR':str(out/'state')}
        command=[str(project/'scripts/nomo'),'--root',str(workspace),'--allow',','.join(FILES),'--check','/bin/sh','-c','grep -qx new note.txt']
        first=interactive(command,env,TASK,True);match=re.search(rb'SESSION ID ([0-9a-f]{32})',first);assert match
        assert b'one read/search up to 1048580 bytes' in first
        assert (workspace/'note.txt').read_text()==AFTER and all((workspace/f).read_text()=='unrelated context\n' for f in FILES[:-1])
        assert stat.S_IMODE(workspace.stat().st_mode)==0o755
        command=[str(project/'scripts/nomo'),'--id',match.group(1).decode(),'--root',str(workspace),'--allow',','.join(FILES)]
        second=interactive(command,env,'现在文件的颜色是什么？',False)
        assert not server.failure and server.phases==list(range(15));assert '当前文件包含 new'.encode() in second
        assert server.evidence_matches, server.evidence_detail
        assert b'work-boundary' in second and b'work-check' in second and b'UNORDERED WORK' not in second
        assert b'duplicate timeline text omitted' in second
        assert second.index(b'work-boundary') < second.index(b'work-check')
        database=out/'state'/'sessions'/match.group(1).decode()/'history.sqlite3'
        with sqlite3.connect(database) as connection:
            rows=connection.execute("select value_json from memory_entries where region='nomo-recoverable-chat-evidence-v1' order by version").fetchall()
            large=connection.execute("select count(*) from memory_entries where region='nomo-large-text-v1'").fetchone()[0]
        assert len(rows)==1 and ('complete: '+DISPLAYED) in rows[0][0] and large == 0
        status = subprocess.run([str(project/'scripts/nomo'), '--id', match.group(1).decode(), '--status'], env=env, capture_output=True, timeout=300)
        assert status.returncode == 0, status.stderr.decode('utf-8', 'replace')
        assert b'NATIVE configured cumulative reservation=10383872; actual provider usage unknown; legacy native budget not present' in status.stdout, status.stdout.decode('utf-8', 'replace')
        print(json.dumps({'status':'passed','scope':'1 MiB interactive natural-language selected-file edit, checkpoint, same-ID new-process continuation','file_bytes':len(BEFORE.encode()),'fake_requests':len(server.phases),'confirmations':2,'archived_chat_outcomes':len(rows),'direct_large_text_rows':large,'selected_file':'note.txt','unchanged_other_files':3}))
    finally:server.shutdown();server.server_close();thread.join(timeout=5);print('evidence',out,flush=True)

if __name__=='__main__':main()
