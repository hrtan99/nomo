#!/usr/bin/env python3
"""Copied local-tryout launcher route with actual Docker/Etas and a fixed HTTP fixture.

Run this observer on the host, not inside a container. The launcher retains all
native application decisions. Python supplies deterministic Model replies and
independently observes files, SQLite, traces, wire contexts and current consent.
"""
import argparse
import errno
from copy import deepcopy
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import subprocess
import tempfile
import termios
import threading
import time

import work_chain_probe as chain

ROOT = Path(__file__).resolve().parent.parent
LAUNCH = ROOT/'scripts/local-tryout.sh'
PORT = 18095
ROOT_ID, CHILD_ID, WORKSPACE = 'tryout-1', 'tryout-2', 'local-tryout'
TARGET, CONTEXT = 'demo/value.txt', 'demo/context.txt'
FIRST = 'Replace old with the color from demo/context.txt'
SECOND = 'Use the confirmed parent blue result and replace blue with green'



_HOST_ROWS = chain.rows
_REQUEST_READ = threading.local()


def active_container():
    command=['docker','ps','--filter','label=com.docker.compose.project=nomo','--filter','label=com.docker.compose.service=dev','--format','{{.ID}}']
    observed=subprocess.run(command,capture_output=True,text=True,check=True,timeout=10)
    containers=observed.stdout.split()
    assert len(containers)==1, 'single serial dev container required for colocated observation'
    return containers[0]


def observed_rows(state,snapshot=None):
    if not getattr(_REQUEST_READ,'active',False):return _HOST_ROWS(state,snapshot)
    container=active_container()
    # HTTP observations share the writer's Linux kernel. They do not open the
    # active WAL/SHM through a concurrent host-Mac SQLite connection.
    script = """import json,sqlite3
from contextlib import closing
uri='file:/state/edit.sqlite3?mode=ro'
with closing(sqlite3.connect(uri,uri=True)) as c:
    rows=c.execute('SELECT region,path,key_json,value_json,version FROM memory_entries ORDER BY region,key_json').fetchall()
    result={'rows':rows,'database_list':c.execute('PRAGMA database_list').fetchall(),'journal_mode':c.execute('PRAGMA journal_mode').fetchone()[0],'in_transaction':c.in_transaction}
print(json.dumps(result))
"""
    command=['docker','exec',container,'python3','-c',script]
    value=json.loads(subprocess.run(command,capture_output=True,text=True,check=True,timeout=15).stdout)
    raw=value['rows']
    if snapshot is not None:
        snapshot['sql_snapshot']=dict(database_uri='file:/state/edit.sqlite3?mode=ro',host_state_directory=str(state),
            container=container,database_list=value['database_list'],journal_mode=value['journal_mode'],in_transaction=value['in_transaction'],
            selected_keys=[dict(region=row[0],key_json=row[2],version=row[4]) for row in raw],
            reader_lifecycle='fresh mode=ro connection explicitly closed inside the same dev container/Linux kernel as the active native writer; host SQLite is used only after process exit')
    result={}
    for region,path,key,body,version in raw:
        name=chain.untag(json.loads(key));selected=result.setdefault(region,{})
        assert name not in selected
        selected[name]=dict(region=region,path=json.loads(path),key_json=key,value_json=body,value=chain.untag(json.loads(body)),version=version)
    return result


class CoLocatedHandler(chain.Handler):
    def do_POST(self):
        _REQUEST_READ.active=True
        try:super().do_POST()
        finally:_REQUEST_READ.active=False


chain.rows=observed_rows


def environment(directory=None, trace=None, model=False):
    value=dict(os.environ)
    for name in list(value):
        if name.startswith(('ETAS_HOST_MODEL','ETAS_HOST_OMLX','NOMO_QWEN','NOMO_GATEWAY')) or name=='NOMO_TRYOUT_TRACE_NAME': value.pop(name)
    value.update(PYTHONDONTWRITEBYTECODE='1',NO_COLOR='1',COMPOSE_ANSI='never')
    if directory is not None:value['NOMO_TRYOUT_DIR']=str(directory)
    if trace is not None:value['NOMO_TRYOUT_TRACE_NAME']=trace
    if model:value['NOMO_QWEN_SERVER_API_KEY']=chain.work.TOKEN
    return value


def retain(folder,name,command,result):
    (folder/(name+'.stdout.bin')).write_bytes(result.stdout)
    (folder/(name+'.stderr.bin')).write_bytes(result.stderr)
    return dict(command=list(map(str,command)),exit=result.returncode,stdout=result.stdout.decode(),stderr=result.stderr.decode())


def plain(folder,name,action,directory=None,args=(),*,model=False,trace=None):
    command=[str(LAUNCH),action]+([str(directory)] if directory is not None else [])+list(args)
    observed=subprocess.run(command,cwd=ROOT,env=environment(directory,trace,model),input=b'',capture_output=True,timeout=60)
    return observed,retain(folder,name,command,observed)


def selectors(selected):
    return ['--id',selected['id'],'--workspace',WORKSPACE,'--path',TARGET]


def request_arguments(selected):
    return selectors(selected)+['--once',selected['request'],'--allow',CONTEXT]


def item(turn,denied=False):
    selected=chain.work.cases.case('local-tryout-'+str(turn),id=ROOT_ID if turn==1 else CHILD_ID,workspace=WORKSPACE,path=TARGET,
                                   allowed=[CONTEXT],context_files={CONTEXT:'blue'},before='old\n' if turn==1 else 'blue\n',target='old' if turn==1 else 'blue')
    color='blue' if turn==1 else 'green'
    selected.update(turn=turn,request=FIRST if turn==1 else SECOND,context_files={CONTEXT:'blue\n'},replacement=color,
                    task='replace selected with '+color,after=color+'\n',final_summary='Confirmed '+color)
    if denied:selected.update(kind='nomo_no',atomic=0,calls=6,exit_zero=False)
    return selected


def reply(selected,context,ordinal):
    if ordinal<4:return chain.work.reply(selected,context,ordinal)
    current=context['current'];parents=context['parent']
    if selected['turn']==1:
        assert parents==[] and current['evidence']['outcome']=='complete: blue<LF>'
        color='blue'
    else:
        assert len(parents)==1 and parents[0]['id']==ROOT_ID and parents[0]['outcome']=='complete: blue<LF>'
        assert parents[0]['final_summary']=='Confirmed blue'
        color='green'
    assert selected['replacement']==color
    if ordinal==4:return chain.work.cases.encoded(['delegate','replace selected with '+color])
    if ordinal==5:return chain.work.cases.encoded(['edit',selected['target'],color])
    assert current['edit']['completed']
    return 'Confirmed '+color


chain.reply=reply


def actions(directory,name):
    return chain.work.actions(json.loads((directory/'state'/name).read_text()))


def hints(output,selected,continuation=False,require_show=True):
    commands=[shlex.split(line) for line in output.decode().splitlines() if line.startswith('./scripts/local-tryout.sh ')]
    if require_show:assert any(command[:3]==['./scripts/local-tryout.sh','show','$NOMO_TRYOUT_DIR'] and command[3:]==selectors(selected) for command in commands), 'missing literal copyable show hint'
    candidates=[command for command in commands if command[:2]==['./scripts/local-tryout.sh','continue']]
    if continuation:
        assert candidates and any('--parent' in command and command[command.index('--parent')+1]==ROOT_ID for command in candidates)
        assert b'template' in output.lower() and b'slot' in output.lower()
    else:assert not candidates, 'saved snapshot must not assert current second-slot execution availability'
    return commands


def resources():
    container=active_container()
    command=['docker','exec',container,'python3','-c','import json;from pathlib import Path;print(json.dumps({n:(Path("/sys/fs/cgroup")/n).read_text().strip() for n in ["memory.max","memory.peak","memory.events","cpu.max","pids.max"]}))']
    value=json.loads(subprocess.run(command,capture_output=True,text=True,check=True,timeout=10).stdout)
    events=dict(line.split() for line in value['memory.events'].splitlines())
    assert value['memory.max']=='4294967296' and value['cpu.max']=='400000 100000' and value['pids.max']=='256'
    assert all(events[name]=='0' for name in ['max','oom','oom_kill','oom_group_kill'])
    return dict(container=container,at_native_confirmation=value)


def pty_command(folder,command,env,selected,preview):
    master,slave=pty.openpty();settings=termios.tcgetattr(slave)
    settings[3]&=~(termios.ECHO|termios.ECHONL);settings[1]&=~termios.ONLCR;termios.tcsetattr(slave,termios.TCSANOW,settings)
    process=subprocess.Popen(command,cwd=ROOT,env=env,stdin=slave,stdout=slave,stderr=subprocess.PIPE,start_new_session=True)
    os.close(slave);out=b'';err=b'';native=False;nominal=False;deadline=time.monotonic()+180;observed_resources=None
    readers={master,process.stderr.fileno()}
    def read_ready(fd):
        nonlocal out,err
        try:data=os.read(fd,65536)
        except OSError as error:
            if error.errno!=errno.EIO:raise
            data=b''
        if not data:readers.discard(fd);return
        if fd==master:out+=data
        else:err+=data
    try:
        while True:
            ready,_,_=select.select(list(readers),[],[],0.02)
            for fd in ready:read_ready(fd)
            combined=out+err
            if b'Type `yes` to approve:' in combined and not native:
                # Normalize transport CRLF only; the canonical JSON preview is
                # compared in full and independent File/SQL bytes remain exact.
                assert preview.encode().rstrip(b'\n') in combined.replace(b'\r\n',b'\n'), 'native consent preceded exact preview'
                observed_resources=resources();native=True;os.write(master,b'yes\n')
            if chain.work.edit.PROMPT in combined and not nominal:
                assert native;nominal=True;os.write(master,b'no\n' if selected['kind']=='nomo_no' else b'y\n')
            if process.poll() is not None:
                # EOF descriptors remain select-readable. Drain current bytes
                # once after process exit, then stop independently of readiness.
                for fd in list(readers):
                    while fd in readers and select.select([fd],[],[],0)[0]:read_ready(fd)
                break
            assert time.monotonic()<deadline,'launcher/native PTY deadline'
        assert native and nominal,'both current native and Nomo confirmations required'
        return subprocess.CompletedProcess(command,process.wait(),out,err),observed_resources
    finally:
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGTERM)
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
        os.close(master);process.stderr.close()
        (folder/'apply.stdout.bin').write_bytes(out);(folder/'apply.stderr.bin').write_bytes(err)


def show(folder,directory,selected,label,phase,expected_reads,journal='completed'):
    trace='trace-'+label+'.json';before=chain.work.edit.previous.inspect(directory/'state')
    observed,record=plain(folder,label,'show',directory,selectors(selected),trace=trace)
    assert observed.returncode==0,record
    assert chain.work.edit.previous.inspect(directory/'state')==before
    recorded=actions(directory,trace);assert set(recorded)<={'Policy.evaluate','Memory.read','Console.stdout_write'}
    groups={}
    for line in observed.stdout.decode().splitlines():
        prefix,_,value=line.partition(' ')
        if value.startswith('{'):groups.setdefault(prefix,[]).append(json.loads(value))
    actual=chain.rows(directory/'state')[chain.CHAIN]['turn:'+str(selected['turn'])]['value']
    assert groups['CHAIN'][0]['phase']==phase and groups['CHAIN'][0]['chain']==ROOT_ID
    assert groups['REMAINING'][0]=={key:str(value) for key,value in (chain.TURN if selected['turn']==1 else chain.ZERO).items()}
    if journal is not None:assert groups['JOURNAL'][0]['phase']==journal
    if phase=='summary-confirmed':
        binding,_=chain.work.edit.expected(selected);chain.assert_record(selected,actual,phase,binding)
        assert groups['EDIT'][0]['before']==selected['before'] and groups['EDIT'][0]['after']==selected['after']
    else:assert 'WORK' not in groups and 'turn:'+str(selected['turn']) not in chain.rows(directory/'state').get(chain.JOURNAL,{})
    # inspect validates both fixed slots and their journals, so the saved
    # root also costs ten reads after a confirmed successor exists.
    assert recorded.count('Memory.read')==expected_reads
    hints(observed.stdout,selected,False,False)
    assert b'snapshot' in observed.stdout.lower() and b'slot' in observed.stdout.lower()
    record.update(actions=recorded,groups=groups);return record


def turn(folder,directory,selected):
    folder.mkdir();state=directory/'state';binding,preview=chain.work.edit.expected(selected)
    before_parent=deepcopy(chain.rows(state).get(chain.CHAIN,{}).get('turn:1')) if selected['turn']==2 else None
    prior=chain.parent_facts(before_parent['value']) if before_parent else []
    server=ThreadingHTTPServer(('127.0.0.1',PORT),CoLocatedHandler);server.daemon_threads=True
    server.item,server.state,server.records,server.lock,server.partial=selected,state,[],threading.Lock(),None
    thread=threading.Thread(target=server.serve_forever,kwargs=dict(poll_interval=0.01),daemon=True);thread.start()
    body=request_arguments(selected)+(['--parent',ROOT_ID] if selected['turn']==2 else [])
    command=[str(LAUNCH),'new' if selected['turn']==1 else 'continue',str(directory),*body]
    trace='trace-turn-'+str(selected['turn'])+'.json'
    record=dict(command=command,item=selected,status='running')
    try:
        result,limits=pty_command(folder,command,environment(directory,trace,True),selected,preview)
        record.update(retain(folder,'apply',command,result),resources=limits)
        assert (result.returncode==0)==selected['exit_zero'],record
        assert (b'SAVED' in result.stdout)==selected['exit_zero']
        rows=chain.rows(state);row=rows[chain.CHAIN]['turn:'+str(selected['turn'])]
        phase='summary-confirmed' if selected['exit_zero'] else 'admitted'
        chain.assert_record(selected,row['value'],phase,binding)
        assert row['value']['chain']==ROOT_ID and set(rows)<={chain.CHAIN,chain.JOURNAL}
        if before_parent:assert rows[chain.CHAIN]['turn:1']==before_parent,'parent mutated'
        chain.assert_http(selected,server.records,binding,prior)
        recorded=actions(directory,trace)
        assert recorded.count('Memory.write')==(5 if selected['exit_zero'] else 1)
        assert recorded.count('Fs.atomic_replace')==selected['atomic'] and recorded.count('Approval.request')==1
        assert sum(chain.work.model_action(action) for action in recorded)==selected['calls']
        assert (directory/'workspace'/TARGET).read_bytes()==(selected['after'] if selected['exit_zero'] else selected['before']).encode()
        if selected['exit_zero']:
            assert rows[chain.JOURNAL]['turn:'+str(selected['turn'])]['value']==dict(format=2,chain=ROOT_ID,turn=selected['turn'],phase='completed',binding=binding)
            assert server.partial is not None and server.partial['version']!=row['version']
        else:assert 'turn:'+str(selected['turn']) not in rows.get(chain.JOURNAL,{})
        record.update(status='passed',phase=phase,rows=rows,actions=recorded,hint_commands=hints(result.stdout,selected,selected['turn']==1 and selected['exit_zero']))
    except BaseException as error:record.update(status='failed',failure=repr(error));raise
    finally:
        server.shutdown();thread.join(timeout=2)
        for request in server.records:request['finished'].wait(2)
        server.server_close()
        record['http']=[{key:value for key,value in request.items() if key!='finished'} for request in server.records]
        (folder/'observation.json').write_text(json.dumps(record,indent=2)+'\n')
    return record


def refusal(folder,directory,label,action,args,model=True):
    trace='trace-'+label+'.json';before=chain.work.edit.previous.inspect(directory/'state')
    result,record=plain(folder,label,action,directory,args,model=model,trace=trace)
    assert result.returncode!=0 and b'REFUSED' in result.stdout,record
    recorded=actions(directory,trace);assert set(recorded)<={'Policy.evaluate','Memory.read','Console.stdout_write'}
    after=chain.work.edit.previous.inspect(directory/'state')
    if label=='malformed':
        # A fresh native profile may initialize empty SQLite schema/catalog
        # before ETAS parses its arguments. No application row or write follows.
        assert chain.rows(directory/'state')=={}
        record.update(native_schema_before=before,native_schema_after=after,
            qualification='fresh native backend initialization may create empty SQLite schema/metadata; no physical-unchanged claim, no application rows and no Model/File/Approval/Memory.write dispatch')
    else:assert after==before
    record['actions']=recorded;return record


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--prepare-only',action='store_true');options=parser.parse_args()
    options.evidence_dir.mkdir(parents=True,exist_ok=True);evidence=Path(tempfile.mkdtemp(prefix='local-tryout-',dir=options.evidence_dir)).resolve()
    print('EVIDENCE '+str(evidence),flush=True)
    record=dict(task='LOCAL-TRYOUT-001',mode='deterministic actual host launcher/Compose/native Etas; live SQL observer colocated in the same Linux container',status='prepared',commands=[])
    save=lambda:(evidence/'results.json').write_text(json.dumps(record,indent=2)+'\n');save()
    if options.prepare_only:return
    try:
        record['status']='running';save()
        help_result,record['help']=plain(evidence,'help','help');assert help_result.returncode==0
        assert all(text in help_result.stdout for text in [b'chain_new',b'chain_continue',b'chain_show',b'--parent',b'--cap'])
        directory=evidence/'copied-guide'
        prepared,setup=plain(evidence,'prepare','prepare',directory);assert prepared.returncode==0,setup
        before=(directory/'workspace'/TARGET).read_bytes()
        collided,record['collision']=plain(evidence,'collision','prepare',directory);assert collided.returncode!=0 and (directory/'workspace'/TARGET).read_bytes()==before
        record['malformed']=refusal(evidence,directory,'malformed','new',['--bad'])
        assert chain.rows(directory/'state')=={}
        first=item(1);record['first']=turn(evidence/'first',directory,first);save()
        record['first_show']=show(evidence,directory,first,'show-root','summary-confirmed',8);save()
        second=item(2);record['second']=turn(evidence/'second',directory,second);save()
        record['second_show']=show(evidence,directory,second,'show-child','summary-confirmed',10);save()
        record['old_parent_show']=show(evidence,directory,first,'show-old-parent','summary-confirmed',10);save()
        record['consumed']=refusal(evidence,directory,'consumed','new',request_arguments(first))
        record['third']=refusal(evidence,directory,'third','continue',request_arguments(dict(second,id='tryout-3'))+['--parent',ROOT_ID])
        denied=evidence/'denied-guide';result,setup=plain(evidence,'prepare-denied','prepare',denied);assert result.returncode==0,setup
        denied_item=item(1,True);record['denial']=turn(evidence/'denial',denied,denied_item)
        record['denial_show']=show(evidence,denied,denied_item,'show-denied','admitted',6,None)
        record['status']='passed'
    except BaseException as error:record.update(status='failed',failure=repr(error));raise
    finally:save()
    print('PASS actual copied-guide two turns, provider-free help/shows and focused refusals',flush=True)


if __name__=='__main__':main()
