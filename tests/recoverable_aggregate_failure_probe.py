#!/usr/bin/env python3
"""Synthetic event-chat to confirmed event-work across real CLI processes."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,sys,tempfile,termios,threading,time
from http.server import HTTPServer
from pathlib import Path
from post_work_continuation_probe import Fake

class AggregateFailureFake(Fake):
    def do_POST(self):
        if len(self.server.phases)!=10:return super().do_POST()
        self.rfile.read(int(self.headers['Content-Length']));self.server.phases.append(10)
        if self.server.mode=='aggregate':self.send_error(503);return
        content={'aggregate-invalid':'X'*1025,'persist-policy':'SYNTHETIC_NEVER_PRESENT','success-short':'Done.','success-reserved':'Edit applied; model summary unavailable (blank or over limit).','success-513':'X'*513,'success-boundary':'é'*512,'success-escaped':chr(1)*1023+'X','fallback-blank':'   ','aggregate-nul':'x\x00'}.get(self.server.mode,'Synthetic summary.')
        data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

ROOT=Path(__file__).resolve().parent.parent

def main():
    mode=sys.argv[1] if len(sys.argv)>1 else 'aggregate'
    assert mode in ('aggregate','aggregate-invalid','persist-policy','success-short','success-reserved','success-513','success-boundary','success-escaped','fallback-blank','aggregate-nul')
    out=Path(tempfile.mkdtemp(prefix='nomo-event-work-'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('green')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n');(workspace/'note.txt').chmod(0o600)
    state=out/'state';state.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_NEVER_PRESENT"]}');(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),AggregateFailureFake);server.phases=[];server.failed=False;server.mode=mode
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();proc=None;master=None
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
        first=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(state),'--allow','context.txt','--once','Read the color and include CEDAR42','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
        assert first.returncode==0 and b'FINAL blue CEDAR42' in first.stdout and server.phases==list(range(4)), 'initial chat failed'
        check='test "$(cat note.txt)" = "before green" && printf x >> check-count.txt && printf FIRST_CHECK_OK'
        cmd=[str(project/'scripts/nomo-read.sh'),'session-work','--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id','edit1','--path','note.txt','--allow','context.txt','--once','Change old to green using context','--events-policy-dir',str(policy),'--check','/bin/sh','-c',check]
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
        fallback=mode in ('aggregate-invalid','fallback-blank');success=mode.startswith('success-') or fallback
        assert (proc.returncode==0 if success else proc.returncode!=0) and native and application and server.phases==list(range(11)), 'unexpected synthetic outcome'
        assert (workspace/'note.txt').read_text()=='before green\n' and b'APPLIED edit1' in output
        if success:assert b'Check passed.' in output and b'SAVED event work facts' in output and (workspace/'check-count.txt').read_text()=='x'
        if fallback:assert b'MODEL SUMMARY unavailable' in output
        if mode=='success-reserved':assert b'MODEL SUMMARY unavailable' not in output
        if not success:assert b'Check passed.' not in output
        expected_stage='persist' if mode=='persist-policy' else 'aggregate'
        if not success:assert ('post_edit_text='+expected_stage).encode() in output
        if mode in ('aggregate','aggregate-nul'):assert b'POST_EDIT events' not in output
        if mode=='persist-policy':assert b'POST_EDIT persist' in output and b'SAVED event work facts' not in output and b'known sensitive literal' in output
        if not success:assert not (workspace/'check-count.txt').exists()
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        lines=[line.removeprefix(b'EVENT VIEW ') for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
        assert status.returncode==0 and len(lines)==1;view=json.loads(lines[0])
        if success:
            assert view['work_phase']=='complete' and view['work_edit_phase']=='completed' and view['work_settled_calls']==7 and view['check_phase']=='complete' and view['check_outcome']=='passed'
            expected={'aggregate-invalid':'Edit applied; model summary unavailable (blank or over limit).','fallback-blank':'Edit applied; model summary unavailable (blank or over limit).','success-short':'Done.','success-reserved':'Edit applied; model summary unavailable (blank or over limit).','success-513':'X'*513,'success-boundary':'é'*512,'success-escaped':chr(1)*1023+'X'}[mode]
            events=[(item['role'],item['kind'],json.loads(item['text'])) for item in view['work_events']]
            assert (('system','notice',expected) if fallback else ('assistant','answer',expected)) in events
            shown=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
            assert shown.returncode==0 and json.dumps(expected,ensure_ascii=True).encode() in shown.stdout and not any(b<32 and b not in (10,13) for b in shown.stdout)
        else:
            assert view['work_phase']=='running' and view['work_edit_phase']=='completed' and view['work_reserved_calls']==7 and view['work_reserved_tokens']==47104 and view['check_phase']=='planned'
            assert b'edit completion was recorded' in status.stdout and b'no start was recorded at this snapshot' in status.stdout and b'a new session does not resolve this one' in status.stdout
        with sqlite3.connect(state/'history.sqlite3') as db:
            assert db.execute('pragma integrity_check').fetchone()==('ok',)
            names={x[0] for x in db.execute("select region from memory_entries")}
            assert {'nomo-recoverable-work-v1','nomo-recoverable-check-v1','nomo-edit-operation-v1'}<=names
        result={'status':'passed','scope':'synthetic post-edit '+mode+'; state shape only, not proof of real cause','fake_requests':len(server.phases),'work_exit':proc.returncode,'edit_applied':True,'work_phase':view['work_phase'],'check_phase':view['check_phase'],'has_unhandled_runtime_error_marker':b'UnhandledRuntimeError' in output,'post_edit_observed':expected_stage}

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
