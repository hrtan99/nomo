#!/usr/bin/env python3
"""Synthetic prior chat followed by a separately approved read/edit/check."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,tempfile,termios,threading,time
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY'
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.phases)
            assert i<15 and req['max_tokens']==[2048,2048,2048,2048,2048,2048,2048,2048,4096,32768,2048,2048,2048,2048,2048][i]
            if i==0:value=['delegate','Read context.txt']
            elif i==1:value=['read','context.txt']
            elif i==2:value=['final','blue CEDAR42']
            elif i==3:value='blue CEDAR42'
            elif i==4:
                assert ctx['previous']['answer']=='blue CEDAR42' and ctx['current']['phase']=='plan';value=['delegate','Read context.txt']
            elif i==5:value=['read','context.txt']
            elif i==6:value=['final','Seen: complete: green']
            elif i==7:
                assert ctx['previous']['answer']=='blue CEDAR42' and 'green' in ctx['current']['outcome'];value='Summary: complete: green'
            elif i==8:
                assert ctx['previous']['answer']=='blue CEDAR42' and ctx['current']['edit']['before']=='before old\n';value=['delegate','replace old with green']
            elif i==9:value=['edit','old','green']
            elif i==10:
                assert ctx['current']['edit']['after']=='before green\n';value='Edit completed using current context.'
            elif i==11:
                assert ctx['work']=={'id':'edit1','summary':'Edit completed using current context.','summary_source':'unknown','check':self.server.expected_check,'exit_code':self.server.expected_exit,'output':{'name':'Some','fields':[{'stdout':'FIRST_CHECK_OK','stderr':'','stdout_truncated':False,'stderr_truncated':False}]}};value=['delegate','Read context.txt']
            elif i==12:value=['read','context.txt']
            elif i==13:value=['final','blue CEDAR42']
            else:
                assert ctx['work']['summary']=='Edit completed using current context.' and ctx['work']['check']==self.server.expected_check;value='Prior edit and check recorded.'
            content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                             'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception:
            self.server.failed=True
            try:self.send_error(500)
            except OSError:pass

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-history-work-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('green')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n');(workspace/'note.txt').chmod(0o600)
    state=out/'state';state.mkdir(mode=0o700);server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;server.expected_check='passed';server.expected_exit='0'
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();proc=None;master=None
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-session-new','nomo-read-session-existing','nomo-history-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
        first=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Read the color and include CEDAR42'],env=env,capture_output=True,timeout=120)
        (out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
        assert first.returncode==0 and b'FINAL blue CEDAR42' in first.stdout and server.phases==list(range(4))
        cmd=[str(project/'scripts/nomo-read.sh'),'session-work','--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id','edit1','--path','note.txt','--allow','context.txt','--once','Change old to green using context','--check','/bin/sh','-c','test "$(cat note.txt)" = "before green" && printf FIRST_CHECK_OK']
        master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
        proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
        output=bytearray();native=False;application=False;deadline=time.monotonic()+120
        while proc.poll() is None:
            if time.monotonic()>deadline:raise TimeoutError()
            if select.select([master],[],[],.1)[0]:
                try:output.extend(os.read(master,65536))
                except OSError:pass
            if not native and b'Type `yes` to approve:' in output:
                previews=[line.removeprefix(b'PREVIEW ') for line in bytes(output).splitlines() if line.startswith(b'PREVIEW ')]
                assert len(previews)==1;v=json.loads(previews[0]);assert v['path']=='note.txt' and v['before']=='before old\n' and v['after']=='before green\n' and v['target']=='old' and v['replacement']=='green'
                os.write(master,b'yes\n');native=True
            if not application and b'CONFIRM Apply this exact preview? [y/N]' in output:
                assert native;os.write(master,b'yes\n');application=True
        while select.select([master],[],[],0)[0]:
            try:data=os.read(master,65536)
            except OSError:break
            if not data:break
            output.extend(data)
        (out/'work.output').write_bytes(output)
        assert proc.returncode==0 and native and application and not server.failed and server.phases==list(range(11))
        assert (workspace/'note.txt').read_text()=='before green\n' and b'Check passed.' in output and b'SAVED history-work' in output
        with sqlite3.connect(state/'history.sqlite3') as c:
            rows=dict(c.execute("select region,value_json from memory_entries where region in ('nomo-history-work-v1','nomo-edit-operation-v1')"))
            assert set(rows)=={'nomo-history-work-v1','nomo-edit-operation-v1'}
            work_phase=next(x['value']['value'] for x in json.loads(rows['nomo-history-work-v1'])['fields'] if x['name']=='phase')
            edit_phase=next(x['value']['value'] for x in json.loads(rows['nomo-edit-operation-v1'])['fields'] if x['name']=='phase')
            assert work_phase=='complete' and edit_phase=='completed' and c.execute('pragma integrity_check').fetchone()==('ok',)
        with sqlite3.connect(state/'history.sqlite3') as c:before=list(c.iterdump())
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        assert status.returncode==0 and b'WORK complete id=edit1 path=note.txt' in status.stdout and b'EDIT completed' in status.stdout and b'WORK BUDGET settled_calls=7 settled_generation=47104' in status.stdout and b'CHAT BUDGET used_calls=4 used_generation=8192' in status.stdout and b'CHECK complete result=passed exit=0' in status.stdout
        # Work from independent SQLite backup copies; do not corrupt the main successful fixture.
        for case, edits in [('wrong-id', {'id':'other1'}), ('planned', {'phase':'planned','outcome':'','exit_code':''}), ('running', {'phase':'running','outcome':'','exit_code':''}), ('unknown', {'phase':'unknown','outcome':'','exit_code':''}), ('failed', {'outcome':'failed','exit_code':'1'})]:
            variant=out/('state-'+case);variant.mkdir(mode=0o700);(variant/'.nomo-session.lock').touch(mode=0o600)
            with sqlite3.connect(state/'history.sqlite3') as source, sqlite3.connect(variant/'history.sqlite3') as dest: source.backup(dest)
            with sqlite3.connect(variant/'history.sqlite3') as c:
                raw=c.execute("select value_json from memory_entries where region='nomo-history-check-v1'").fetchone()[0]
                obj=json.loads(raw)
                for field in obj['fields']:
                    if field['name'] in edits: field['value']['value']=edits[field['name']]
                c.execute("update memory_entries set value_json=? where region='nomo-history-check-v1'",(json.dumps(obj,separators=(',',':')),))
            server.phases=list(range(11));server.expected_check='failed' if case=='failed' else 'passed';server.expected_exit='1' if case=='failed' else '0'
            trial=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(context),'--state',str(variant),'--allow','context.txt','--once','What happened to the edit?'],env=env,capture_output=True,timeout=120)
            (out/('variant-'+case+'.stdout')).write_bytes(trial.stdout);(out/('variant-'+case+'.stderr')).write_bytes(trial.stderr)
            if case=='failed': assert trial.returncode==0 and server.phases==list(range(15)) and not server.failed
            else: assert trial.returncode!=0 and b'REFUSED' in trial.stdout and server.phases==list(range(11))
        server.phases=list(range(11));server.expected_check='passed';server.expected_exit='0'
        continued=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(context),'--state',str(state),'--allow','context.txt','--once','What happened to the edit?'],env=env,capture_output=True,timeout=120)
        (out/'continue.stdout').write_bytes(continued.stdout);(out/'continue.stderr').write_bytes(continued.stderr)
        assert continued.returncode==0 and b'Prior edit and check recorded.' in continued.stdout and server.phases==list(range(15)) and not server.failed
        assert (workspace/'note.txt').read_text()=='before green\n'
        again=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Third turn'],env=env,capture_output=True,timeout=120)
        assert again.returncode!=0 and server.phases==list(range(15))
        result={'status':'passed','scope':'local fake completed work and check followed by fresh read continuation; no root identity or real provider','fake_requests':15,'work_and_check_facts_verified':True,'third_turn_refused':True,'file_preserved':True,'wrong_id_and_unresolved_checks_rejected':True,'failed_check_preserved':True}
    except BaseException as error:result={'status':'failed','failure_type':type(error).__name__,'phases':server.phases,'work_exit':proc.poll() if proc else None}
    finally:
        if proc and proc.poll() is None:
            os.killpg(proc.pid,signal.SIGTERM)
            try:proc.wait(timeout=25)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
        if master is not None:os.close(master)
        server.shutdown();server.server_close();thread.join(timeout=5)
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
