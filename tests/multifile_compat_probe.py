#!/usr/bin/env python3
"""Continue an old synthetic two-file event session using the new four-file path."""
import json,os,shutil,subprocess,sys,tempfile,threading
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
FILES=['one.txt','two.txt','three.txt','four.txt']

class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY'
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            data=json.loads(request['messages'][1]['content']);i=len(self.server.calls)
            if i==0:value=['delegate','Search the selected files']
            elif i==1:
                assert data['allowed']==FILES[:2];value=['search','marker',*FILES[:2]]
            elif i==2:value=['final','Both old files contained the marker']
            elif i==3:value='Two old files matched.'
            elif i==4:
                prior=data['prior'];assert prior['tool']=='search' and 'one.txt:1' in prior['outcome'] and 'two.txt:1' in prior['outcome']
                assert data['allowed']==FILES;value=['delegate','Read the fourth selected file']
            elif i==5:
                assert data['allowed']==FILES
                history=json.dumps(data['history'],ensure_ascii=False)
                assert 'one.txt:1' in history and 'two.txt:1' in history
                value=['read','four.txt']
            elif i==6:value=['final','Fourth selected file is green']
            elif i==7:value='Old results and the fourth file were retained.'
            elif i==8:
                assert data['current']['phase']=='plan'
                history=' '.join(item['text'] for item in data['history'])
                assert 'Find both markers' in history and 'Two old files matched.' in history and 'Old results and the fourth file were retained.' in history
                value=['delegate','Read four.txt']
            elif i==9:value=['read','four.txt']
            elif i==10:value=['final','Fourth selected file is green']
            elif i==11:value='Third turn completed.'
            elif i==12:
                assert 'Third turn completed.' in ' '.join(item['text'] for item in data['history'])
                value=['delegate','Read one.txt']
            elif i==13:value=['read','one.txt']
            elif i==14:value=['final','First file has marker']
            elif i==15:value='Fourth turn completed.'
            else:raise ValueError('unexpected request')
            content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            body=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
            self.server.calls.append(i);self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except Exception:
            self.server.failed=True
            try:self.send_error(500)
            except OSError:pass

def main():
    if len(sys.argv)!=2:raise SystemExit('supply an isolated archive of the pre-change product')
    baseline=Path(sys.argv[1]).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='nomo-multifile-compat-') as tmp:
        out=Path(tmp);old=out/'old';new=out/'new'
        for source,target in ((baseline,old),(ROOT,new)):
            shutil.copytree(source,target,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'))
            (target/'.etas').mkdir(mode=0o700)
        context=out/'context';context.mkdir(mode=0o700)
        for name in FILES:(context/name).write_text('marker '+name+'\n')
        state=out/'state';state.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
        (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_NEVER_PRESENT"]}');(policy/'policy.json').chmod(0o600)
        (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
        server=HTTPServer(('127.0.0.1',0),Fake);server.calls=[];server.failed=False
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            for project in (old,new):
                manifest=project/'etas.toml';text=manifest.read_text()
                for name in ('nomo-read-events-new','nomo-read-events-existing'):
                    start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
                    part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
                manifest.write_text(text)
            env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
            def run(project,action,allowed,question):
                return subprocess.run([str(project/'scripts/nomo-read.sh'),action,'--root',str(context),'--state',str(state),
                    '--allow',','.join(allowed),'--once',question,'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
            first=run(old,'session-new',FILES[:2],'Find both markers')
            if first.returncode or server.calls!=list(range(4)):raise AssertionError('old first turn failed: '+(first.stdout+first.stderr).decode('utf-8','replace')[-1500:])
            resumed=run(old,'session-continue',FILES,'Read the fourth file and recall the old results')
            if resumed.returncode or server.calls!=list(range(8)) or server.failed:raise AssertionError('old second turn failed: '+(resumed.stdout+resumed.stderr).decode('utf-8','replace')[-1500:])
            for question,expected in [('Recall both earlier answers',12),('Continue with first file',16)]:
                resumed=run(new,'session-continue',FILES,question)
                if resumed.returncode or server.calls!=list(range(expected)) or server.failed:raise AssertionError('new continuation failed: '+(resumed.stdout+resumed.stderr).decode('utf-8','replace')[-2000:])
            status=subprocess.run([str(new/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
            views=[json.loads(line.removeprefix(b'EVENT VIEW ')) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
            assert status.returncode==0 and len(views)==1 and views[0]['turns']==4 and views[0]['phase']=='ready'
            assert views[0]['used_calls']==16 and views[0]['used_tokens']==32768 and views[0]['used_tools']==4
            text=' '.join(json.loads(item['text']) for item in views[0]['events'])
            assert 'one.txt:1' in text and 'two.txt:1' in text and 'four.txt' in text
        finally:server.shutdown();server.server_close();thread.join(timeout=5)
    print(json.dumps({'status':'passed','scope':'old two-turn synthetic session continued twice by new product','fake_requests':16,'old_results_preserved':True}))

if __name__=='__main__':main()
