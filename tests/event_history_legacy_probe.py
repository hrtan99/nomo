#!/usr/bin/env python3
"""Exercise two native read-session processes with a local synthetic provider."""
import json,os,shutil,sqlite3,subprocess,tempfile,threading
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
    out=Path(tempfile.mkdtemp(prefix='nomo-event-legacy-',dir='/private/tmp'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.etas','__pycache__'));assert not (project/'.etas').exists()
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    context2=out/'context2';context2.mkdir(mode=0o700);(context2/'context.txt').write_text('green\n')
    state=out/'state';state.mkdir(mode=0o700)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-session-new','nomo-read-session-existing'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true')
            text=text[:start]+part+text[end:]
        manifest.write_text(text)
        env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY'}
        def run(action,question,selected=context):
            cmd=[str(project/'scripts/nomo-read.sh'),action,'--root',str(selected),'--state',str(state),'--allow','context.txt','--once',question]
            return subprocess.run(cmd,env=env,capture_output=True,timeout=120)
        first=run('session-new','Read color and include CEDAR42')
        (out/'first.stdout').write_bytes(first.stdout);(out/'first.stderr').write_bytes(first.stderr)
        assert first.returncode==0 and [line for line in first.stdout.splitlines() if line.startswith(b'FINAL ')]==[b'FINAL blue CEDAR42'] and b'SAVED chat history' in first.stdout
        assert (project/'.etas').is_dir() and not (project/'.etas').is_symlink() and (project/'.etas').stat().st_mode & 0o777==0o700
        assert server.phases==[0,1,2,3]
        # Reconstruct an existing pre-events v1 chat after one successful turn.
        with sqlite3.connect(state/'history.sqlite3') as connection:
            raw=connection.execute("select value_json from memory_entries where region='nomo-chat-history-v1'").fetchone()[0];value=json.loads(raw)
            field=next(x for x in value['fields'] if x['name']=='format');assert field['value']['value']=='2';field['value']['value']='1'
            connection.execute("update memory_entries set value_json=? where region='nomo-chat-history-v1'",(json.dumps(value,separators=(',',':')),))
            connection.execute("delete from memory_entries where region='nomo-event-history-v1'")
        second=run('session-continue','What tag was in the previous answer?',context2)
        (out/'second.stdout').write_bytes(second.stdout);(out/'second.stderr').write_bytes(second.stderr)
        assert second.returncode==0 and [line for line in second.stdout.splitlines() if line.startswith(b'FINAL ')]==[b'FINAL CEDAR42'] and b'SAVED chat history' in second.stdout
        assert server.phases==list(range(8)) and not server.failed
        db=state/'history.sqlite3'
        with sqlite3.connect(db) as connection:before=list(connection.iterdump());assert connection.execute('pragma integrity_check').fetchone()==('ok',)
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state)],env=env,capture_output=True,timeout=120)
        (out/'status.stdout').write_bytes(status.stdout);(out/'status.stderr').write_bytes(status.stderr)
        assert status.returncode==0 and b'SESSION complete turns=2' in status.stdout and b'EVENTS unavailable for legacy or unfinished history' in status.stdout and server.phases==list(range(8))
        third=run('session-continue','Should be refused')
        (out/'third.stdout').write_bytes(third.stdout);(out/'third.stderr').write_bytes(third.stderr)
        assert third.returncode!=0 and b'REFUSED' in third.stdout and server.phases==list(range(8))
        with sqlite3.connect(db) as connection:assert list(connection.iterdump())==before
        assert (context/'context.txt').read_text()=='blue\n' and (context2/'context.txt').read_text()=='green\n'
        result={'status':'passed','scope':'synthetic format-1 continuation compatibility; no real provider or edit','model_requests':8,
                'prior_answer_checked':True,'fresh_different_root_read_checked':True,'offline_status_checked':True,'third_turn_refused':True,'context_unchanged':True,'state_unchanged_on_refusal':True}
    except BaseException as e:result={'status':'failed','failure_type':type(e).__name__,'phases':server.phases}
    finally:server.shutdown();server.server_close();thread.join(timeout=5)
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
