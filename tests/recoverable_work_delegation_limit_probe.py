#!/usr/bin/env python3
"""Real work-entry boundary checks with synthetic responses and no edit."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,tempfile,termios,threading,time
from http.server import HTTPServer
from pathlib import Path
from post_work_continuation_probe import Fake

ROOT=Path(__file__).resolve().parent.parent
class BoundaryFake(Fake):
    def do_POST(self):
        i=len(self.server.phases)
        if i<4:return super().do_POST()
        self.rfile.read(int(self.headers['Content-Length']));self.server.phases.append(i)
        if i==5:self.send_error(503);return
        if self.server.mode=='escaped512':content='["delegate","'+'\\u0058'*512+'"]'
        else:content=json.dumps(['delegate','X'*int(self.server.mode)],separators=(',',':'))
        data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                         'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

def execute(command,env):
    master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
    proc=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);output=bytearray();deadline=time.monotonic()+120
    try:
        while proc.poll() is None:
            if time.monotonic()>deadline:raise TimeoutError('synthetic work timeout')
            if select.select([master],[],[],.1)[0]:
                try:output.extend(os.read(master,65536))
                except OSError:pass
        while select.select([master],[],[],0)[0]:
            try:data=os.read(master,65536)
            except OSError:break
            if not data:break
            output.extend(data)
        return proc.returncode,bytes(output)
    finally:
        if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
        os.close(master)

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-work-limit-'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'))
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('blue\n')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n')
    initial=out/'initial';initial.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_NEVER_PRESENT"]}');(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),BoundaryFake);server.phases=[];server.failed=False
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();results={}
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
        first=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(initial),'--allow','context.txt','--once','Read the color and include CEDAR42','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        assert first.returncode==0 and server.phases==list(range(4)) and not server.failed
        for mode in ('128','129','512','escaped512','513'):
            state=out/('state-'+mode);state.mkdir(mode=0o700);(state/'.nomo-session.lock').touch(mode=0o600)
            with sqlite3.connect(initial/'history.sqlite3') as src,sqlite3.connect(state/'history.sqlite3') as dst:src.backup(dst)
            (state/'history.sqlite3').chmod(0o600);server.phases=list(range(4));server.mode=mode
            command=[str(project/'scripts/nomo-read.sh'),'session-work','--read-root',str(context),'--root',str(workspace),'--state',str(state),'--id','edit1','--path','note.txt','--allow','context.txt','--once','Change old to green using context','--events-policy-dir',str(policy),'--check','/bin/true']
            code,output=execute(command,env)
            assert code==3 and b'PREVIEW ' not in output and b'APPLIED ' not in output and (workspace/'note.txt').read_text()=='before old\n'
            if mode=='513':assert len(server.phases)==5 and b'REFUSED invalid bounded delegated task' in output and b'plan_rejection_text=length' in output
            else:assert len(server.phases)==6 and b'STAGE read-child' in output
            results[mode]={'fake_work_requests':len(server.phases)-4,'entered_child':mode!='513','preview':False}
        print(json.dumps({'status':'passed','scope':'local synthetic work-plan limits; no real provider or edit','cases':results}))
    finally:server.shutdown();server.server_close();thread.join(timeout=5);shutil.rmtree(out)

if __name__=='__main__':main()
