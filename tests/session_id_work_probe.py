#!/usr/bin/env python3
"""Synthetic prior chat followed by a separately approved read/edit/check."""
import json,os,pty,re,select,shutil,signal,sqlite3,subprocess,tempfile,termios,threading,time
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
from post_work_continuation_probe import Fake

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-session-id-work-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('green')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n');(workspace/'note.txt').chmod(0o600)
    sessions=out/'sessions';sessions.mkdir(mode=0o700);server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False;server.expected_check='passed';server.expected_exit='0'
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();proc=None;master=None
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-session-new','nomo-read-session-existing','nomo-history-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
        first=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','start','--sessions-dir',str(sessions),'--root',str(context),'--allow','context.txt','--once','Read the color and include CEDAR42'],env=env,capture_output=True,timeout=120)
        (out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
        assert first.returncode==0 and b'FINAL blue CEDAR42' in first.stdout and server.phases==list(range(4))
        ids=re.findall(rb'^SESSION ID ([0-9a-f]{32})$',first.stdout,re.M);assert len(ids)==1;session_id=ids[0].decode();state=sessions/session_id
        cmd=[str(project/'scripts/nomo-read.sh'),'session-id','work','--sessions-dir',str(sessions),'--id',session_id,'--read-root',str(current),'--root',str(workspace),'--operation-id','edit1','--path','note.txt','--allow','context.txt','--once','Change old to green using context','--check','/bin/sh','-c','test "$(cat note.txt)" = "before green"']
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
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','status','--sessions-dir',str(sessions),'--id',session_id],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        assert status.returncode==0 and b'WORK complete id=edit1 path=note.txt' in status.stdout and b'EDIT completed' in status.stdout and b'WORK BUDGET settled_calls=7 settled_generation=47104' in status.stdout and b'CHAT BUDGET used_calls=4 used_generation=8192' in status.stdout and b'CHECK complete result=passed exit=0' in status.stdout
        # Preserve the committed work and edit rows across resumed chat.
        with sqlite3.connect(state/'history.sqlite3') as c:
            recorded=dict(c.execute("select region,value_json from memory_entries where region in ('nomo-history-work-v1','nomo-edit-operation-v1','nomo-history-check-v1')"))
        for phase in ('running','unknown'):
            registry=out/('sessions-'+phase);registry.mkdir(mode=0o700);variant=registry/session_id;variant.mkdir(mode=0o700);(variant/'.nomo-session.lock').touch(mode=0o600)
            with sqlite3.connect(state/'history.sqlite3') as source, sqlite3.connect(variant/'history.sqlite3') as dest: source.backup(dest)
            with sqlite3.connect(variant/'history.sqlite3') as c:
                raw=c.execute("select value_json from memory_entries where region='nomo-history-check-v1'").fetchone()[0]
                obj=json.loads(raw)
                for field in obj['fields']:
                    if field['name']=='phase':field['value']['value']=phase
                    if field['name'] in ('outcome','exit_code'):field['value']['value']=''
                c.execute("update memory_entries set value_json=? where region='nomo-history-check-v1'",(json.dumps(obj,separators=(',',':')),))
                before_variant=list(c.iterdump())
            server.phases=list(range(11))
            trial=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','resume','--sessions-dir',str(registry),'--id',session_id,'--root',str(context),'--allow','context.txt','--once','What happened to the edit?'],env=env,capture_output=True,timeout=120)
            (out/('variant-'+phase+'.stdout')).write_bytes(trial.stdout);(out/('variant-'+phase+'.stderr')).write_bytes(trial.stderr)
            assert trial.returncode!=0 and b'REFUSED' in trial.stdout and server.phases==list(range(11))
            with sqlite3.connect(variant/'history.sqlite3') as c: assert list(c.iterdump())==before_variant
        server.phases=list(range(11))
        continued=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','resume','--sessions-dir',str(sessions),'--id',session_id,'--root',str(context),'--allow','context.txt','--once','What happened to the edit?'],env=env,capture_output=True,timeout=120)
        (out/'continue.stdout').write_bytes(continued.stdout);(out/'continue.stderr').write_bytes(continued.stderr)
        assert continued.returncode==0 and b'Prior edit and check recorded.' in continued.stdout and server.phases==list(range(15)) and not server.failed
        assert (workspace/'note.txt').read_text()=='before green\n'
        with sqlite3.connect(state/'history.sqlite3') as c:
            assert dict(c.execute("select region,value_json from memory_entries where region in ('nomo-history-work-v1','nomo-edit-operation-v1','nomo-history-check-v1')"))==recorded
        after=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','status','--sessions-dir',str(sessions),'--id',session_id],env=env,capture_output=True,timeout=120)
        (out/'after.stdout').write_bytes(after.stdout);(out/'after.stderr').write_bytes(after.stderr)
        assert after.returncode==0 and b'CHAT BUDGET used_calls=8 used_generation=16384' in after.stdout and b'WORK BUDGET settled_calls=7 settled_generation=47104' in after.stdout
        again=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','resume','--sessions-dir',str(sessions),'--id',session_id,'--root',str(context),'--allow','context.txt','--once','What happened to the edit?'],env=env,capture_output=True,timeout=120)
        (out/'exhausted.stdout').write_bytes(again.stdout);(out/'exhausted.stderr').write_bytes(again.stderr)
        assert again.returncode!=0 and b'REFUSED' in again.stdout and server.phases==list(range(15)) and (workspace/'note.txt').read_text()=='before green\n'
        result={'status':'passed','scope':'local fake completed work/check and resumed read chat; no root identity or real model','fake_requests':15,'continued':True,'running_and_unknown_check_refused':True,'budget_preserved':True,'file_and_work_records_preserved':True}
    except BaseException as error:result={'status':'failed','failure_type':type(error).__name__,'phases':server.phases,'work_exit':proc.poll() if proc else None,'error':str(error)}
    finally:
        if proc and proc.poll() is None:
            os.killpg(proc.pid,signal.SIGTERM)
            try:proc.wait(timeout=25)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
        if master is not None:os.close(master)
        server.shutdown();server.server_close();thread.join(timeout=5)
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
