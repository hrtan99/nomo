#!/usr/bin/env python3
"""Synthetic check failure must be recorded after a completed edit."""
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
            assert i<11 and req['max_tokens']==[2048,2048,2048,2048,2048,2048,2048,2048,4096,32768,2048][i]
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
            else:
                assert ctx['current']['edit']['after']=='before green\n';value='Edit completed using current context.'
            content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                             'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception:
            self.server.failed=True
            try:self.send_error(500)
            except OSError:pass

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-history-check-failed-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('green')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n');(workspace/'note.txt').chmod(0o600)
    state=out/'state';state.mkdir(mode=0o700);server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False
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
        cmd=[str(project/'scripts/nomo-read.sh'),'session-work','--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id','edit1','--path','note.txt','--allow','context.txt','--once','Change old to green using context','--check','/bin/sh','-c','exit 7']
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
        assert proc.returncode==7 and native and application and not server.failed and server.phases==list(range(11))
        assert (workspace/'note.txt').read_text()=='before green\n' and b'Check failed (exit 7).' in output and b'CHECK SAVED' in output and b'SAVED history-work' in output
        with sqlite3.connect(state/'history.sqlite3') as c:
            rows=dict(c.execute("select region,value_json from memory_entries where region in ('nomo-history-work-v1','nomo-edit-operation-v1')"))
            assert set(rows)=={'nomo-history-work-v1','nomo-edit-operation-v1'}
            work_phase=next(x['value']['value'] for x in json.loads(rows['nomo-history-work-v1'])['fields'] if x['name']=='phase')
            edit_phase=next(x['value']['value'] for x in json.loads(rows['nomo-edit-operation-v1'])['fields'] if x['name']=='phase')
            assert work_phase=='complete' and edit_phase=='completed' and c.execute('pragma integrity_check').fetchone()==('ok',)
        with sqlite3.connect(state/'history.sqlite3') as c:before=list(c.iterdump())
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        assert status.returncode==0 and b'WORK complete id=edit1 path=note.txt' in status.stdout and b'EDIT completed' in status.stdout and b'WORK BUDGET settled_calls=7 settled_generation=47104' in status.stdout and b'CHAT BUDGET used_calls=4 used_generation=8192' in status.stdout and b'CHECK complete result=failed exit=7' in status.stdout
        rejected=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Next question'],env=env,capture_output=True,timeout=120)
        (out/'rejected.stdout').write_bytes(rejected.stdout);(out/'rejected.stderr').write_bytes(rejected.stderr)
        assert rejected.returncode!=0 and b'REFUSED' in rejected.stdout and server.phases==list(range(11))
        with sqlite3.connect(state/'history.sqlite3') as c:assert list(c.iterdump())==before
        result={'status':'passed','scope':'synthetic check failure after completed edit; no real model','fake_requests':11,
                'prior_answer_verified':True,'status_and_chat_refusal_checked':True,'native_and_application_approval':True,'exact_preview_checked':True,'file_changed':True,'offline_check_failure_recorded':True,'durable_edit_and_work_records':True}
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
