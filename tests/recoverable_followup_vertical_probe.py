#!/usr/bin/env python3
"""Synthetic prior chat followed by a separately approved read/edit/check."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,sys,tempfile,termios,threading,time
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY'
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.phases)
            assert i<22 and req['max_tokens']==[2048,2048,2048,2048,2048,2048,2048,2048,4096,32768,2048,2048,2048,2048,2048,4096,32768,2048,2048,2048,2048,2048][i]
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
                assert ctx['previous']['answer']=='blue CEDAR42' and ctx['prior_work']['summary']=='Edit completed using current context.' and ctx['prior_work']['check']=='passed';value=['delegate','Read context.txt']
            elif i==12:value=['read','context.txt']
            elif i==13:value=['final','Seen: complete: green']
            elif i==14:
                assert ctx['prior_work']['check']=='passed' and 'green' in ctx['current']['outcome'];value='Summary: complete: green'
            elif i==15:
                output=ctx['prior_work']['output']['fields'][0]
                assert ctx['current']['edit']['before']=='before green\n' and ctx['prior_work']['check']=='passed'
                if self.server.omitted:assert output['stdout']=='' and output['stdout_truncated'] and 'was omitted and is not evidence of empty output' in req['messages'][0]['content']
                else:assert output['stdout']=='FIRST_CHECK_OK'
                value=['delegate','replace green with gold']
            elif i==16:value=['edit','green','gold']
            elif i==17:
                assert ctx['current']['edit']['after']=='before gold\n';value='Second edit completed using current context.'
            elif i==18:
                for key,identifier,summary,stdout in [('work','edit1','Edit completed using current context.','FIRST_CHECK_OK'),('followup','edit2','Second edit completed using current context.','SECOND_CHECK_OK')]:
                    item=ctx[key];assert item['id']==identifier and item['summary']==summary and item['summary_source']=='model' and item['check']=='passed' and item['exit_code']=='0'
                    data=item['output']['fields'][0];assert data['stderr'] in ('','\n') and not data['stderr_truncated']
                    if self.server.omitted and key=='work':assert data['stdout']=='' and data['stdout_truncated'] and 'was omitted and is not evidence of empty output' in req['messages'][0]['content']
                    else:assert data['stdout']==stdout and not data['stdout_truncated']
                assert ctx['budget']=={'work_calls':14,'work_generation':94208,'chat_used_calls':4,'chat_used_generation':8192,'chat_reserved_calls':4,'chat_reserved_generation':8192};value=['delegate','Read context.txt']
            elif i==19:value=['read','context.txt']
            elif i==20:value=['final','blue CEDAR42']
            else:
                assert ctx['followup']['check']==self.server.expected_check and ctx['work']['check']=='passed';value='Both edits and checks recorded.'
            if i==17 and self.server.fail_summary:
                self.server.phases.append(i);self.send_error(503);return
            content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                             'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception:
            self.server.failed=True
            try:self.send_error(500)
            except OSError:pass

def omitted_check():
    return 'test "$(cat note.txt)" = "before green" || exit 1; i=0; while [ "$i" -lt 4500 ]; do printf X; i=$((i+1)); done'

def main():
    omitted=len(sys.argv)>1 and sys.argv[1]=='omitted'
    out=Path(tempfile.mkdtemp(prefix='nomo-event-followup-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('green')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n');(workspace/'note.txt').chmod(0o600)
    state=out/'state';state.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_NEVER_PRESENT"]}');(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;server.fail_summary=False;server.expected_check='passed';server.expected_exit='0';server.omitted=omitted
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();proc=None;master=None
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
        first=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Read the color and include CEDAR42','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
        assert first.returncode==0 and server.phases==list(range(4)), 'initial chat failed'
        def run_work(action,identifier,before,after):
            nonlocal proc,master
            check='test "$(cat note.txt)" = "before '+after+'" && printf '+('FIRST_CHECK_OK' if action=='session-work' else 'SECOND_CHECK_OK')
            if omitted and action=='session-work':check=omitted_check()
            cmd=[str(project/'scripts/nomo-read.sh'),action,'--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id',identifier,'--path','note.txt','--allow','context.txt','--once','Change '+before+' to '+after+' using context','--events-policy-dir',str(policy),'--check','/bin/sh','-c',check]
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
                    assert len(previews)==1;v=json.loads(previews[0]);assert v['path']=='note.txt' and v['before']=='before '+before+'\n' and v['after']=='before '+after+'\n' and v['target']==before and v['replacement']==after
                    os.write(master,b'yes\n');native=True
                if not application and b'CONFIRM Apply this exact preview? [y/N]' in output:
                    assert native;os.write(master,b'yes\n');application=True
            while select.select([master],[],[],0)[0]:
                try:data=os.read(master,65536)
                except OSError:break
                if not data:break
                output.extend(data)
            (out/(action+'.output')).write_bytes(output);os.close(master);master=None
            assert proc.returncode==0 and native and application and b'Check passed.' in output,action+' failed'
            assert (workspace/'note.txt').read_text()=='before '+after+'\n'
        run_work('session-work','edit1','old','green')
        assert server.phases==list(range(11))
        run_work('session-followup','edit2','green','gold')
        assert not server.failed and server.phases==list(range(18))
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        assert status.returncode==0 and b'RECORDED FOLLOWUP complete' in status.stdout and b'RECORDED FOLLOWUP CHECK complete' in status.stdout
        views=[json.loads(line.removeprefix(b'EVENT VIEW ')) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')];assert len(views)==1;view=views[0]
        assert view['work_settled_calls']==7 and view['followup_settled_calls']==7 and view['followup_settled_tokens']==47104
        assert view['check_outcome']=='passed' and view['followup_check_outcome']=='passed' and view['followup_check_id']=='edit2' and json.loads(view['followup_check_stdout'])=='SECOND_CHECK_OK'
        if omitted:assert view['check_stdout_omitted'] and view['check_stdout_truncated'] and json.loads(view['check_stdout'])==''
        with sqlite3.connect(state/'history.sqlite3') as db:
            assert db.execute('pragma integrity_check').fetchone()==('ok',)
            names={x[0] for x in db.execute("select region from memory_entries")}
            assert {'nomo-recoverable-work-v1','nomo-recoverable-check-v1','nomo-recoverable-followup-v1','nomo-recoverable-followup-check-v1','nomo-edit-operation-v1','nomo-edit-followup-v1'}<=names
        resumed=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(current),'--state',str(state),'--allow','context.txt','--once','Explain recorded results','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'resume.stdout').write_bytes(resumed.stdout);(out/'resume.stderr').write_bytes(resumed.stderr)
        assert resumed.returncode==0 and not server.failed and server.phases==list(range(22)) and b'SAVED chat and event records together' in resumed.stdout
        result={'status':'passed','scope':'local fake two separately confirmed work/check rounds and read continuation with persisted selected facts; no root identity or real provider','fake_requests':22,'first_check_omitted':omitted,'fresh_confirmations_twice':True,'check_slots_and_budgets_preserved':True,'resume_received_both_checks':True}
    except BaseException as error:result={'status':'failed','failure_type':type(error).__name__,'phases':server.phases,'work_exit':proc.poll() if proc else None,'error':str(error)}
    finally:
        if proc and proc.poll() is None:
            os.killpg(proc.pid,signal.SIGTERM)
            try:proc.wait(timeout=25)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
        if master is not None:os.close(master)
        server.shutdown();server.server_close();thread.join(timeout=5)
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out),'error':result.get('error')}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
