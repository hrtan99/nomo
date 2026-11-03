#!/usr/bin/env python3
"""Synthetic event-chat to confirmed event-work across real CLI processes."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,sys,tempfile,termios,threading,time
from http.server import HTTPServer
from pathlib import Path
from post_work_continuation_probe import Fake
ROOT=Path(__file__).resolve().parent.parent

def main():
    mode=sys.argv[1] if len(sys.argv)>1 else 'pass'
    assert mode in ('pass','fail','interrupt','truncate','boundary','oversize','storagefail')
    out=Path(tempfile.mkdtemp(prefix='nomo-event-work-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('green')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n');(workspace/'note.txt').chmod(0o600)
    state=out/'state';state.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_NEVER_PRESENT"]}');(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False
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
        check={'pass':'test "$(cat note.txt)" = "before green" && printf FIRST_CHECK_OK','fail':'printf FIRST_CHECK_FAILED; exit 7','interrupt':'sleep 30','truncate':'printf SYNTHETIC_NEVER_PRESENT; i=0; while [ "$i" -lt 150 ]; do printf X; i=$((i+1)); done','boundary':'i=0; while [ "$i" -lt 120 ]; do printf X; i=$((i+1)); done; printf SYNTHETIC_NEVER_PRESENT','oversize':'i=0; while [ "$i" -lt 4500 ]; do printf X; i=$((i+1)); done','storagefail':'sleep 2; printf CHECK_FINISHED'}[mode]
        cmd=[str(project/'scripts/nomo-read.sh'),'session-work','--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id','edit1','--path','note.txt','--allow','context.txt','--once','Change old to green using context','--events-policy-dir',str(policy),'--check','/bin/sh','-c',check]
        master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
        proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
        output=bytearray();native=False;application=False;interrupted=False;changed_policy=False;deadline=time.monotonic()+120
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
            if mode=='interrupt' and not interrupted and b'Running the requested check offline' in output:
                os.killpg(proc.pid,signal.SIGINT);interrupted=True
            if mode=='storagefail' and not changed_policy and b'Running the requested check offline' in output:
                (policy/'policy.json').write_bytes((policy/'policy.json').read_bytes()+b' ');changed_policy=True
        while select.select([master],[],[],0)[0]:
            try:data=os.read(master,65536)
            except OSError:break
            if not data:break
            output.extend(data)
        (out/'work.output').write_bytes(output)
        if changed_policy:(policy/'policy.json').write_bytes((policy/'policy.json').read_bytes()[:-1])
        assert (proc.returncode==0 if mode in ('pass','truncate','boundary','oversize') else proc.returncode!=0) and native and application and not server.failed and server.phases==list(range(11)), 'work failed'
        assert (workspace/'note.txt').read_text()=='before green\n' and b'APPLIED edit1' in output and b'SAVED event work facts' in output
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        phase='running' if mode in ('interrupt','storagefail') else 'complete'
        assert status.returncode==0 and b'RECORDED WORK complete' in status.stdout and ('RECORDED CHECK '+phase).encode() in status.stdout, 'status failed'
        lines=[line.removeprefix(b'EVENT VIEW ') for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
        assert len(lines)==1;view=json.loads(lines[0]);assert view['work_phase']=='complete' and view['work_settled_calls']==7 and view['work_settled_tokens']==47104
        assert view['check_phase']==phase and view['check_id']=='edit1'
        if mode in ('interrupt','storagefail'):
            assert (interrupted if mode=='interrupt' else changed_policy and b'CHECK_FINISHED' in output and b'event policy unavailable or changed' in output)
            assert view['check_outcome']=='' and view['check_stdout']==''
        else:
            assert view['check_outcome']==('failed' if mode=='fail' else 'passed') and view['check_exit']==('7' if mode=='fail' else '0')
            if mode=='truncate':assert json.loads(view['check_stdout']).startswith('[REDACTED]') and view['check_stdout_truncated']
            elif mode=='boundary':assert json.loads(view['check_stdout']).startswith('X'*120+'[REDACT') and 'SYNTHETIC' not in json.loads(view['check_stdout']) and view['check_stdout_truncated'] and not view['check_stdout_omitted']
            elif mode=='oversize':assert json.loads(view['check_stdout'])=='' and view['check_stdout_truncated'] and view['check_stdout_omitted'] and b'CHECK OUTPUT omitted' in status.stdout
            else:assert json.loads(view['check_stdout'])==('FIRST_CHECK_OK' if mode=='pass' else 'FIRST_CHECK_FAILED')
            assert json.loads(view['check_stderr']) in ('','\n')
        with sqlite3.connect(state/'history.sqlite3') as db:
            assert db.execute('pragma integrity_check').fetchone()==('ok',)
            rows=dict(db.execute("select region,value_json from memory_entries where region in ('nomo-recoverable-work-v1','nomo-recoverable-check-v1','nomo-edit-operation-v1','nomo-history-work-v1')"))
            assert 'nomo-recoverable-work-v1' in rows and 'nomo-recoverable-check-v1' in rows and 'nomo-edit-operation-v1' in rows and 'nomo-history-work-v1' not in rows
            assert 'SYNTHETIC_NEVER_PRESENT' not in rows['nomo-recoverable-work-v1']
            assert 'SYNTHETIC_NEVER_PRESENT' not in rows['nomo-recoverable-check-v1']
        if mode in ('interrupt','storagefail'):
            resumed=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(current),'--state',str(state),'--allow','context.txt','--once','continue','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
            (out/'resume.stdout').write_bytes(resumed.stdout);(out/'resume.stderr').write_bytes(resumed.stderr)
            assert resumed.returncode!=0 and server.phases==list(range(11)) and (workspace/'note.txt').read_text()=='before green\n', 'unresolved continuation was not refused'
            os.close(master);master=None
            follow=[str(project/'scripts/nomo-read.sh'),'session-followup','--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id','edit2','--path','note.txt','--allow','context.txt','--once','Change green to gold','--events-policy-dir',str(policy)]
            master,slave=pty.openpty();next_proc=subprocess.Popen(follow,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);next_output=bytearray();until=time.monotonic()+90
            while next_proc.poll() is None:
                if time.monotonic()>until:os.killpg(next_proc.pid,signal.SIGTERM);next_proc.wait(timeout=10);raise TimeoutError('followup refusal')
                if select.select([master],[],[],.1)[0]:
                    try:next_output.extend(os.read(master,65536))
                    except OSError:pass
            while select.select([master],[],[],0)[0]:
                try:data=os.read(master,65536)
                except OSError:break
                if not data:break
                next_output.extend(data)
            (out/'followup-refused.output').write_bytes(next_output)
            assert next_proc.returncode!=0 and not server.failed and server.phases==list(range(11)) and b'PREVIEW ' not in next_output and (workspace/'note.txt').read_text()=='before green\n', 'unresolved followup was not refused before model'
        result={'status':'passed','scope':'synthetic event-chat, confirmed work and actual offline check; selected facts only; no root identity or real provider','check_mode':mode,'fake_requests':len(server.phases),'native_and_application_confirmed_exact_preview':True,'file_and_work_frame_complete':True,'check_phase':phase,'unresolved_continuation_refused':mode in ('interrupt','storagefail')}
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
