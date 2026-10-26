#!/usr/bin/env python3
"""Actual owned-file PTY edit checks, using accepted trace/storage primitives."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import termios
import time
import tomllib

import harness_session_probe as previous
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
REGION = 'nomo.tools.edit_file.EditableRoot'
PROMPT = b'CONFIRM Apply this exact preview? [y/N]'
POLICY_ENV = ['ETAS_HOST_POLICY','ETAS_HOST_POLICY_RULES','ETAS_HOST_POLICY_URL','ETAS_HOST_POLICY_TOKEN',
              'ETAS_HOST_POLICY_PATH','ETAS_HOST_POLICY_ALLOW_PRIVATE','ETAS_HOST_POLICY_RETRY_ATTEMPTS',
              'ETAS_HOST_POLICY_RETRY_DELAY_MS','ETAS_HOST_BOUNDARY_POLICY','ETAS_HOST_APPROVAL',
              'ETAS_HOST_MEMORY','ETAS_HOST_MEMORY_PATH','ETAS_HOST_WORKSPACE_ROOT','ETAS_HOST_FILESYSTEM']
previous.storage.DB_NAMES = ('edit.sqlite3',)

def ascii_json(value):
    def quote(text):
        out = '"'
        for char in text:
            code = ord(char)
            if char in ['"','\\']: out += '\\'+char
            elif 32 <= code <= 126: out += char
            elif code <= 65535: out += '\\u'+format(code,'04x')
            else:
                code -= 65536
                out += '\\u'+format(55296+(code>>10),'04x')+'\\u'+format(56320+(code&1023),'04x')
        return out+'"'
    if isinstance(value,dict): return '{'+','.join(quote(k)+':'+quote(v) for k,v in value.items())+'}'
    return '['+','.join(quote(v) for v in value)+']'

def expected(item):
    before, after = item['before'], item['after']
    digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
    canonical = ascii_json(['nomo-edit-request-v1',item['id'],item['workspace'],REGION,item['path'],
                            before,item['target'],item['replacement'],after])
    binding = dict(id=item['id'],workspace=item['workspace'],region=REGION,path=item['path'],
                   request_digest=digest(canonical),before_digest=digest(before),after_digest=digest(after),
                   before_bytes=len(before.encode()),after_bytes=len(after.encode()))
    preview = dict(format='nomo-edit-preview-v1',id=item['id'],workspace=item['workspace'],region=REGION,path=item['path'],
                   before=before,target=item['target'],replacement=item['replacement'],after=after,
                   before_bytes=str(binding['before_bytes']),after_bytes=str(binding['after_bytes']),
                   before_digest=binding['before_digest'],after_digest=binding['after_digest'],request_digest=binding['request_digest'])
    return binding, 'PREVIEW '+ascii_json(preview)+'\n'

def rows(state):
    path=state/'edit.sqlite3'
    if not path.exists(): return {}
    with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) as db:
        if not db.execute("SELECT name FROM sqlite_master WHERE name='memory_entries'").fetchall(): return {}
        data=db.execute('SELECT region,path,key_json,value_json,version FROM memory_entries').fetchall()
    return {previous.storage.untag(json.loads(key)):
            dict(region=region,path=json.loads(store),value=previous.storage.untag(json.loads(value)),version=version)
            for region,store,key,value,version in data}

def environment(apply=True):
    env=dict(os.environ)
    for key in POLICY_ENV: env.pop(key,None)
    if apply: env['ETAS_HOST_APPROVAL']='prompt'
    return env

def manifest(state, workspace, status=False):
    text=(ROOT/'etas.toml').read_text().replace('path = "edit.sqlite3"','path = '+json.dumps(str(state/'edit.sqlite3')))
    text=text.replace('path = "file:edit.sqlite3?mode=rw"','path = '+json.dumps('file:'+str(state/'edit.sqlite3')+'?mode=rw'))
    text=text.replace('root = "/edit-fixture"','root = '+json.dumps(str(workspace)))
    if status:
        output=[];skip=False
        for line in text.splitlines():
            if line.startswith('['):
                skip=any('.'+kind in line for kind in ['model','filesystem','approval']) and line.startswith('[runtime.profiles.')
            if not skip: output.append(line)
        text='\n'.join(output)+'\n'
    return text

def run_pty(argv, state, item, folder, binding):
    master,slave=pty.openpty();settings=termios.tcgetattr(slave)
    settings[3] &= ~(termios.ECHO|termios.ECHONL);settings[1] &= ~termios.ONLCR
    settings[6][termios.VEOF]=b'\x04';termios.tcsetattr(slave,termios.TCSANOW,settings)
    proc=subprocess.Popen(argv,cwd=state,env=environment(),stdin=slave,stdout=slave,stderr=subprocess.PIPE,start_new_session=True)
    os.close(slave);out=b'';err=b'';native=False;nominal=False;deadline=time.monotonic()+90;milestones=[]
    try:
        while True:
            ready,_,_=select.select([master,proc.stderr.fileno()],[],[],0.02)
            for fd in ready:
                try: raw=os.read(fd,65536)
                except OSError as error:
                    if error.errno!=errno.EIO: raise
                    raw=b''
                if fd==master:out+=raw
                else:err+=raw
            if b'Type `yes` to approve:' in err and not native:
                assert expected(item)[1].encode() in out, 'native prompt preceded complete exact preview'
                assert rows(state)=={}, 'intent existed before both current confirmations'
                native=True;milestones.append('native_prompt_observed');os.write(master,b'no\n' if item['kind']=='native_no' else b'yes\n')
            if PROMPT in out and not nominal:
                nominal=True;milestones.append('nomo_prompt_observed')
                assert rows(state)=={}
                if item['kind']=='mismatch': (folder/item['path']).write_text('external change')
                if item['kind']=='completion_error':
                    with sqlite3.connect(state/'edit.sqlite3') as db:
                        db.execute("CREATE TRIGGER reject_edit_completion BEFORE UPDATE ON memory_entries BEGIN SELECT RAISE(ABORT,'owned completion refusal'); END")
                answer={'nomo_no':b'no\n','nomo_blank':b'\n','nomo_eof':b'\x04'}.get(item['kind'],b' YeS \n')
                os.write(master,answer)
            if b'INTENT durable ' in out and 'intent_observed' not in milestones:
                current=rows(state)
                assert set(current)=={'operation'} and current['operation']['value']['binding']==binding
                milestones.append('intent_observed')
            if b'APPLIED ' in out and 'applied_observed' not in milestones:
                assert rows(state)['operation']['value']==dict(format=1,phase='completed',binding=binding)
                milestones.append('applied_observed')
            if proc.poll() is not None and not ready: break
            if proc.poll() is not None:
                # Drain both output descriptors once more after process exit.
                for fd in [master,proc.stderr.fileno()]:
                    try:
                        while select.select([fd],[],[],0)[0]:
                            try: raw=os.read(fd,65536)
                            except OSError: break
                            if not raw: break
                            if fd==master:out+=raw
                            else:err+=raw
                    except OSError: pass
                break
            assert time.monotonic()<deadline, 'PTY edit deadline'
        return out,err,proc.wait(),milestones
    finally:
        if proc.poll() is None: os.killpg(proc.pid,signal.SIGKILL);proc.wait()
        os.close(master);proc.stderr.close()
        if item['kind']!='read_only': os.chmod(folder,0o700)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--suite',choices=['smoke','remaining','tail','readonly'],default='smoke');options=parser.parse_args()
    cli=verify_cli();options.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='edit-write-',dir=options.evidence_dir))
    names={'smoke':['applied'],'remaining':['non_tty','native_no','nomo_no','nomo_blank','nomo_eof','mismatch','completion_error','boundary','deletion'],
           'tail':['completion_error','boundary','deletion'],'readonly':['read_only']}[options.suite]
    result=dict(task='TOOL-002B',status='running',suite=options.suite,cases=[],commands=[]);output=evidence/'results.json'
    save=lambda:output.write_text(json.dumps(result,indent=2)+'\n')
    print('EVIDENCE '+str(evidence),flush=True)
    try:
        for name in names:
            case=evidence/name;state=case/'state';workspace=case/'workspace';project=case/'project';status_project=case/'status-project'
            state.mkdir(parents=True,mode=0o700)
            if name=='read_only': workspace=Path('/edit-fixture-readonly')
            else: workspace.mkdir(mode=0o700)
            item=dict(id='owned-edit',workspace='owned-label',path='note.txt',before='前😀\r\nold\x1b\x7f\x9b\n',target='old',replacement='新',after='前😀\r\n新\x1b\x7f\x9b\n',kind=name)
            if name=='boundary':item.update(before='\x1b'*2048,target='\x1b'*2048,replacement='\x02'*2048,after='\x02'*2048)
            if name=='deletion':item.update(before='x'*2048,target='x'*2048,replacement='',after='')
            if name!='read_only':
                (workspace/item['path']).write_bytes(item['before'].encode());os.chmod(workspace/item['path'],0o600)
            else:
                assert (workspace/item['path']).read_bytes()==item['before'].encode()
                mount=next(line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4]==str(workspace))
                assert 'ro' in mount[5].split(',')
            for dest,readonly in [(project,False),(status_project,True)]:
                shutil.copytree(ROOT/'src',dest/'src');shutil.copyfile(ROOT/'etas.lock',dest/'etas.lock')
                (dest/'etas.toml').write_text(manifest(state,workspace,readonly))
            args=['--id',item['id'],'--workspace',item['workspace'],'--path',item['path']]
            argv=[str(cli),'run',str(project),'--flow','edit_apply','--allow-effects','--trace-out',str(case/'apply.trace.json'),'--args',*args,'--target',item['target'],'--replacement',item['replacement']]
            profile=subprocess.run([str(cli),'run',str(project),'--flow','edit_apply','--print-runtime-profile'],cwd=state,env=environment(),capture_output=True,timeout=15)
            (case/'profile.stdout.bin').write_bytes(profile.stdout);(case/'profile.stderr.bin').write_bytes(profile.stderr)
            assert profile.returncode==0 and not profile.stderr
            effective=json.loads(profile.stdout);assert effective['approval']=='Prompt'
            assert effective['memory']==dict(kind='sqlite',path=str(state/'edit.sqlite3'))
            assert effective['filesystem_regions']==[dict(identity=REGION,root=str(workspace),read=True,write=True,delete=False)]
            binding,preview=expected(item)
            if name=='non_tty':
                proc=subprocess.Popen(argv,cwd=state,env=environment(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
                # Keep stdin open and provide no data: Prompt must refuse without waiting.
                proc.wait(timeout=20);out=proc.stdout.read();err=proc.stderr.read();proc.stdin.close();code=proc.returncode;milestones=['open_pipe_terminated']
            else:out,err,code,milestones=run_pty(argv,state,item,workspace,binding)
            (case/'apply.stdout.bin').write_bytes(out);(case/'apply.stderr.bin').write_bytes(err)
            record=dict(name=name,status='observed',item=item,argv=argv,exit=code,stdout=out.decode(),stderr=err.decode(),milestones=milestones,effective_profile=effective)
            result['cases'].append(record);save()
            assert preview.encode() in out and all(32<=byte<=126 for byte in out.split(b'\n')[0]), 'preview not complete printable ASCII'
            success=name in ['applied','boundary','deletion'];current=(workspace/item['path']).read_bytes();journal=rows(state)
            assert (code==0)==success and (b'APPLIED '+item['id'].encode() in out)==success
            if success:assert current==item['after'].encode() and journal['operation']['value']==dict(format=1,phase='completed',binding=binding)
            elif name in ['mismatch','completion_error','read_only']:
                assert journal['operation']['value']==dict(format=1,phase='intent',binding=binding)
                assert current==('external change'.encode() if name=='mismatch' else item['after'].encode() if name=='completion_error' else item['before'].encode())
            else:assert current==item['before'].encode() and journal=={}
            trace=json.loads((case/'apply.trace.json').read_text());starts=[e for e in trace['events'] if e['kind']=='host_request_started']
            actions=[e.get('qualified_action','') for e in starts]
            atomic=[a for a in actions if 'atomic_replace' in a];assert len(atomic)==(1 if success or name in ['completion_error','read_only'] else 0)
            assert not any('Model' in a or 'Command' in a or 'Fs.write'==a for a in actions)
            if name in ['non_tty','native_no']:assert 'Console.stdin_read_line' not in actions and PROMPT not in out
            if name!='non_tty':assert b'Type `yes` to approve:' in err
            assert err.count(b'Type `yes` to approve:')==(0 if name=='non_tty' else 1)
            before=previous.inspect(state)
            status_argv=[str(cli),'run',str(status_project),'--flow','edit_status','--allow-effects','--trace-out',str(case/'status.trace.json'),'--args',*args]
            shown=subprocess.run(status_argv,cwd=state,env=environment(False),capture_output=True,timeout=20)
            (case/'status.stdout.bin').write_bytes(shown.stdout);(case/'status.stderr.bin').write_bytes(shown.stderr)
            assert shown.returncode==0 and not shown.stderr and previous.inspect(state)==before
            stored=json.loads(shown.stdout.decode().splitlines()[0][len('OPERATION '):]);assert stored['phase']==('completed' if success else 'intent' if journal else 'empty')
            if journal:
                assert stored==dict(format='nomo-edit-operation-v1',phase='completed' if success else 'intent',**{key:str(value) for key,value in binding.items()})
            status_trace=json.loads((case/'status.trace.json').read_text())
            status_actions=[e.get('qualified_action','') for e in status_trace['events'] if e['kind']=='host_request_started']
            assert set(status_actions)<= {'Policy.evaluate','Console.stdout_write','Memory.read'}
            if journal:
                for opid in [item['id'],'different-id']:
                    retry=list(argv);retry[retry.index('--id')+1]=opid;retry[retry.index('--trace-out')+1]=str(case/('retry-'+opid+'.trace.json'))
                    refused=subprocess.run(retry,cwd=state,env=environment(),input=b'',capture_output=True,timeout=20)
                    assert refused.returncode!=0 and refused.stdout==b'REFUSED edit operation slot already consumed; no retry\n'
                    retrace=json.loads(Path(retry[retry.index('--trace-out')+1]).read_text())
                    assert {e.get('qualified_action','') for e in retrace['events'] if e['kind']=='host_request_started'}<= {'Policy.evaluate','Console.stdout_write','Memory.read'}
                assert (workspace/item['path']).read_bytes()==current
            record.update(status='passed',actions=actions,status_actions=status_actions,journal=journal)
            save();print('PASS '+name,flush=True)
        result['status']='passed'
    except BaseException as error:
        result.update(status='failed',failure=repr(error));save();raise
    finally:
        result['resources']={n:(Path('/sys/fs/cgroup')/n).read_text().strip() for n in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
        events=dict(line.split() for line in result['resources']['memory.events'].splitlines())
        if result['resources']['memory.max']!='4294967296' or result['resources']['cpu.max']!='400000 100000' or result['resources']['pids.max']!='256' or any(events[key]!='0' for key in ['max','oom','oom_kill','oom_group_kill']):
            result.update(status='failed',failure='ordinary resource guard failed');save();raise AssertionError(result['failure'])
        save()

if __name__=='__main__':main()
