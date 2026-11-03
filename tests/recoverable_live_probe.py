#!/usr/bin/env python3
"""Exercise two native read-session processes with a local synthetic provider."""
import json,os,re,shutil,sqlite3,subprocess,tempfile,threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY'
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));assert body['max_tokens']==2048
            ctx=json.loads(body['messages'][1]['content']);i=len(self.server.phases);assert i<8
            if i in (0,4):
                assert ctx['phase']=='plan'
                if i==4:assert ctx['prior']['answer']=='blue CEDAR42'
                value=['delegate','Read context.txt'] if i==0 else ['delegate','Use prior answer']
            elif i in (1,5):value=['read','context.txt']
            elif i in (2,6):
                if i==6:assert 'green' in ctx['history'][-1]['text']
                value=['final','blue CEDAR42'] if i==2 else ['final','CEDAR42']
            else:value='blue CEDAR42' if i==3 else 'CEDAR42'
            content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                             'usage':{'prompt_tokens':900,'completion_tokens':200,'total_tokens':1100}}).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception:
            self.server.failed=True
            try:self.send_error(500)
            except OSError:pass

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-session-vertical-',dir='/Users/hrtan/Projects/nomo/tmp/a07-live-3369515/evidence'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));assert not (project/'.etas').exists()
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    context2=out/'context2';context2.mkdir(mode=0o700);(context2/'context.txt').write_text('green\n')
    state=out/'state';state.mkdir(mode=0o700)
    policy=out/'policy';policy.mkdir(mode=0o700);(policy/'policy.json').write_text(json.dumps({'format':1,'literals':['VERY_SECRET_123']}));(policy/'policy.json').chmod(0o600);(policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true')
            text=text[:start]+part+text[end:]
        manifest.write_text(text)
        env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY'}
        def run(action,question,selected=context):
            cmd=[str(project/'scripts/nomo-read.sh'),action,'--root',str(selected),'--state',str(state),'--allow','context.txt','--once',question,'--events-policy-dir',str(policy)]
            return subprocess.run(cmd,env=env,capture_output=True,timeout=120)
        first=run('session-new','Read color and include CEDAR42')
        (out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
        assert first.returncode==0 and [line for line in first.stdout.splitlines() if line.startswith(b'FINAL ')]==[b'FINAL blue CEDAR42'] and b'SAVED chat and event records together' in first.stdout
        assert (project/'.etas').is_dir() and not (project/'.etas').is_symlink() and (project/'.etas').stat().st_mode & 0o777==0o700
        assert server.phases==[0,1,2,3]
        second=run('session-continue','What tag was in the previous answer?',context2)
        (out/'second.stdout').write_bytes(second.stdout);(out/'second.stderr').write_bytes(second.stderr)
        assert second.returncode==0 and [line for line in second.stdout.splitlines() if line.startswith(b'FINAL ')]==[b'FINAL CEDAR42'] and b'SAVED chat and event records together' in second.stdout
        assert server.phases==list(range(8)) and not server.failed
        db=state/'history.sqlite3'
        with sqlite3.connect(db) as connection:before=list(connection.iterdump());assert connection.execute('pragma integrity_check').fetchone()==('ok',)
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        assert status.returncode==0 and server.phases==list(range(8))
        lines=[line[len(b'EVENT VIEW '):] for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
        assert len(lines)==1;view=json.loads(lines[0]);assert view['phase']=='complete' and view['turns']==2 and view['encoding']=='json-string-v1'
        assert view['used_calls']==8 and view['used_tokens']==16384 and view['used_tools']==2 and view['used_scan']==8192 and view['reserved_calls']==0 and view['reserved_tokens']==0
        contents=[json.loads(event['text']) for event in view['events']]
        assert any('blue' in item for item in contents) and any('green' in item for item in contents)
        assert any(event['role']=='tool' and 'complete' in json.loads(event['text']) for event in view['events'])
        assert not any(event['role']=='model' and event['name']=='qwen' for event in view['events'])
        assert 'VERY_SECRET_123' not in status.stdout.decode()
        policy_file=policy/'policy.json';original_policy=policy_file.read_bytes();policy_file.write_bytes(original_policy+b' ')
        changed=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'changed-policy.stdout').write_bytes(changed.stdout);(out/'changed-policy.stderr').write_bytes(changed.stderr)
        assert changed.returncode!=0 and b'policy binding' in changed.stdout and server.phases==list(range(8))
        policy_file.write_bytes(original_policy)
        key_file=policy/'binding.key';original_key=key_file.read_bytes();key_file.write_bytes(b'Q'*32)
        changed_key=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'changed-key.stdout').write_bytes(changed_key.stdout);(out/'changed-key.stderr').write_bytes(changed_key.stderr)
        assert changed_key.returncode!=0 and b'policy binding' in changed_key.stdout and server.phases==list(range(8))
        key_file.write_bytes(original_key)
        legacy=out/'legacy';legacy.mkdir(mode=0o700);(legacy/'.nomo-session.lock').touch(mode=0o600)
        legacy_source=Path('/Users/hrtan/Projects/nomo/tmp/a07-output-view-20261103/evidence/nomo-history-work-tgq8_o5h/state/history.sqlite3')
        with sqlite3.connect(legacy_source) as src, sqlite3.connect(legacy/'history.sqlite3') as dst:src.backup(dst)
        refusal=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(context),'--state',str(legacy),'--allow','context.txt','--once','Hello','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'legacy.stdout').write_bytes(refusal.stdout);(out/'legacy.stderr').write_bytes(refusal.stderr)
        assert refusal.returncode!=0 and b'legacy session cannot be migrated automatically' in refusal.stdout and server.phases==list(range(8))
        third=run('session-continue','Should be refused')
        (out/'third.stdout').write_bytes(third.stdout);(out/'third.stderr').write_bytes(third.stderr)
        assert third.returncode!=0 and b'REFUSED' in third.stdout and server.phases==list(range(8))
        with sqlite3.connect(db) as connection:assert list(connection.iterdump())==before
        assert (context/'context.txt').read_text()=='blue\n' and (context2/'context.txt').read_text()=='green\n'
        # Verify the ID-addressed user route and bounded non-TTY continuation.
        registry=out/'registry';registry.mkdir(mode=0o700);server.phases=[]
        start=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-id','start','--sessions-dir',str(registry),'--root',str(context),'--allow','context.txt','--once','Read color and include CEDAR42','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'id-start.stdout').write_bytes(start.stdout);(out/'id-start.stderr').write_bytes(start.stderr)
        ids=re.findall(rb'^SESSION ID ([0-9a-f]{32})$',start.stdout,re.M)
        assert start.returncode==0 and len(ids)==1 and server.phases==list(range(4))
        chat_cmd=[str(project/'scripts/nomo-read.sh'),'session-chat','--sessions-dir',str(registry),'--id',ids[0].decode(),'--root',str(context2),'--allow','context.txt','--events-policy-dir',str(policy)]
        piped=subprocess.run(chat_cmd,input=b'What tag was in the previous answer?\n',env=env,capture_output=True,timeout=120)
        (out/'pipe.stdout').write_bytes(piped.stdout);(out/'pipe.stderr').write_bytes(piped.stderr)
        assert piped.returncode==0 and b'SAVED chat and event records together' in piped.stdout and server.phases==list(range(8))
        multi=subprocess.run(chat_cmd,input=b'question\nyes\n',env=env,capture_output=True,timeout=120)
        (out/'pipe-multi.stdout').write_bytes(multi.stdout);(out/'pipe-multi.stderr').write_bytes(multi.stderr)
        assert multi.returncode==64 and server.phases==list(range(8))
        # A known literal in a newly requested tool result cannot be safely
        # retained as the selected continuation. Preserve the reservation and
        # refuse replay instead of persisting or silently changing that result.
        secret_context=out/'secret-context';secret_context.mkdir(mode=0o700);(secret_context/'context.txt').write_text('blue\nVERY_SECRET_123\n')
        secret_state=out/'secret-state';secret_state.mkdir(mode=0o700);server.phases=[]
        secret_cmd=[str(project/'scripts/nomo-read.sh'),'session-new','--root',str(secret_context),'--state',str(secret_state),'--allow','context.txt','--once','Read color and include CEDAR42','--events-policy-dir',str(policy)]
        secret_run=subprocess.run(secret_cmd,env=env,capture_output=True,timeout=120)
        (out/'secret.stdout').write_bytes(secret_run.stdout);(out/'secret.stderr').write_bytes(secret_run.stderr)
        assert secret_run.returncode!=0 and b'chat contains a known sensitive literal' in secret_run.stdout and b'SAVED chat and event records together' not in secret_run.stdout
        assert b'A final answer is provisional' in secret_run.stdout and server.phases==list(range(4))
        with sqlite3.connect(secret_state/'history.sqlite3') as connection:
            assert connection.execute('pragma integrity_check').fetchone()==('ok',)
            rows=connection.execute("select value_json from memory_entries where region='nomo-recoverable-chat-v1'").fetchall()
            assert len(rows)==1 and 'VERY_SECRET_123' not in rows[0][0] and 'running' in rows[0][0]
        for path in secret_state.glob('history.sqlite3*'):assert b'VERY_SECRET_123' not in path.read_bytes()
        secret_status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(secret_state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'secret-status.stdout').write_bytes(secret_status.stdout);(out/'secret-status.stderr').write_bytes(secret_status.stderr)
        secret_lines=[line[len(b'EVENT VIEW '):] for line in secret_status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
        assert secret_status.returncode==0 and len(secret_lines)==1
        secret_view=json.loads(secret_lines[0]);assert secret_view['phase']=='running' and secret_view['turns']==0 and secret_view['reserved_calls']==4 and secret_view['reserved_tokens']==8192 and secret_view['events']==[]
        replay=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(secret_context),'--state',str(secret_state),'--allow','context.txt','--once','Again','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        (out/'secret-replay.stdout').write_bytes(replay.stdout);(out/'secret-replay.stderr').write_bytes(replay.stderr)
        assert replay.returncode!=0 and b'REFUSED' in replay.stdout and server.phases==list(range(4))
        result={'status':'passed','scope':'synthetic two-process native chat; no real provider or edit','model_requests':8,
                'prior_answer_checked':True,'fresh_different_root_read_checked':True,'offline_status_checked':True,'third_turn_refused':True,'context_unchanged':True,'state_unchanged_on_refusal':True,'actual_tool_records':True,'legacy_refused':True,
                'known_sensitive_selected_outcome_refused_without_replay':True,'secret_case_fake_requests':4,'id_and_single_pipe_checked':True,'multiline_pipe_refused':True}
    except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'phases':server.phases}
    finally:server.shutdown();server.server_close();thread.join(timeout=5)
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
