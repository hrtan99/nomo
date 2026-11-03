#!/usr/bin/env python3
"""Two confirmed synthetic edits with multilingual read evidence and continuation."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,tempfile,termios,threading,time
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
FIRST_TASK='请将 old 替换为 green'
SECOND_TASK='Change green to gold using context'
DELEGATE='读取 context.txt 中的颜色；'+'确认颜色并保留相关上下文。'*5
CHILD='当前颜色是绿色'
READ_SUMMARY='文件内容是绿色'
FIRST_SUMMARY='已按绿色上下文完成编辑'
SECOND_SUMMARY='Second edit completed.'

class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY'
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.phases)
            assert req['max_tokens']==[2048,2048,2048,2048,2048,2048,2048,2048,4096,32768,2048,2048,2048,2048,2048,4096,32768,2048,2048,2048,2048,2048][i]
            if i==0:value=['delegate','读取 context.txt']
            elif i==1:value=['read','context.txt']
            elif i==2:value=['final','初始颜色为蓝色']
            elif i==3:value='初始颜色为蓝色'
            elif i==4:
                assert ctx['current']['request']==FIRST_TASK and ctx['previous']['answer']=='初始颜色为蓝色';value=['delegate',DELEGATE]
            elif i==5:value=['read','context.txt']
            elif i==6:value=['final',CHILD]
            elif i==7:
                assert ctx['current']['task']==DELEGATE and ctx['current']['result']==CHILD and '绿色' in ctx['current']['outcome'];value=READ_SUMMARY
            elif i==8:
                evidence=ctx['current']['evidence'];assert evidence['request']==FIRST_TASK and evidence['task']==DELEGATE and evidence['result']==CHILD and evidence['summary']==READ_SUMMARY and '绿色' in evidence['outcome']
                value=['delegate','把 old 替换为 green']
            elif i==9:value=['edit','old','green']
            elif i==10:
                assert ctx['current']['edit']['after']=='before green\n';value=FIRST_SUMMARY
            elif i==11:
                assert ctx['current']['request']==SECOND_TASK and ctx['prior_work']['summary']==FIRST_SUMMARY;value=['delegate','Read context.txt for the color']
            elif i==12:value=['read','context.txt']
            elif i==13:value=['final',CHILD]
            elif i==14:
                assert ctx['current']['result']==CHILD and '绿色' in ctx['current']['outcome'];value=READ_SUMMARY
            elif i==15:
                assert ctx['prior_work']['summary']==FIRST_SUMMARY and ctx['current']['evidence']['summary']==READ_SUMMARY;value=['delegate','Replace green with gold']
            elif i==16:value=['edit','green','gold']
            elif i==17:value=SECOND_SUMMARY
            elif i==18:
                assert ctx['work']['summary']==FIRST_SUMMARY and ctx['followup']['summary']==SECOND_SUMMARY;value=['delegate','Read context.txt']
            elif i==19:value=['read','context.txt']
            elif i==20:value=['final','记录完整']
            elif i==21:value='两次编辑均已记录'
            else:raise AssertionError('unexpected extra request')
            content=json.dumps(value,ensure_ascii=False,separators=(',',':')) if isinstance(value,list) else value
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                             'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}},ensure_ascii=False).encode()
            self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception:
            self.server.failed=True
            try:self.send_error(500)
            except OSError:pass

def work(command,env,before,after):
    master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
    proc=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
    output=bytearray();native=application=False;deadline=time.monotonic()+120
    try:
        while proc.poll() is None:
            if time.monotonic()>deadline:raise TimeoutError('synthetic work timeout')
            if select.select([master],[],[],.1)[0]:
                try:output.extend(os.read(master,65536))
                except OSError:pass
            if not native and b'Type `yes` to approve:' in output:
                previews=[line.removeprefix(b'PREVIEW ') for line in bytes(output).splitlines() if line.startswith(b'PREVIEW ')]
                assert len(previews)==1;preview=json.loads(previews[0]);assert preview['path']=='note.txt' and preview['before']=='before '+before+'\n' and preview['after']=='before '+after+'\n' and preview['target']==before and preview['replacement']==after
                os.write(master,b'yes\n');native=True
            if not application and b'CONFIRM Apply this exact preview? [y/N]' in output:
                assert native;os.write(master,b'yes\n');application=True
        while select.select([master],[],[],0)[0]:
            try:data=os.read(master,65536)
            except OSError:break
            if not data:break
            output.extend(data)
        if proc.returncode!=0:raise AssertionError('synthetic work failed at marker '+str([x.decode('ascii','replace') for x in bytes(output).splitlines() if x.startswith((b'STAGE ',b'REFUSED ',b'error['))][-4:]))
        assert native and application and b'Check passed.' in output
    finally:
        if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
        os.close(master)

def main():
    out=Path(tempfile.mkdtemp(prefix='nomo-work-unicode-'));project=out/'project'
    shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'));(project/'.etas').mkdir(mode=0o700)
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('蓝色 blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('绿色 green\n')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n')
    state=out/'state';state.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_NEVER_PRESENT"]}');(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        manifest=project/'etas.toml';text=manifest.read_text()
        for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
            start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
        manifest.write_text(text);env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
        first=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(state),'--allow','context.txt','--once','读取初始颜色','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        if first.returncode:raise AssertionError('synthetic initial chat failed: '+first.stderr.decode('utf-8','replace')[-2000:])
        assert server.phases==list(range(4)) and not server.failed
        for action,identifier,before,after,task in [('session-work','edit1','old','green',FIRST_TASK),('session-followup','edit2','green','gold',SECOND_TASK)]:
            check='test "$(cat note.txt)" = "before '+after+'" && printf CHECK_OK'
            cmd=[str(project/'scripts/nomo-read.sh'),action,'--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id',identifier,'--path','note.txt','--allow','context.txt','--once',task,'--events-policy-dir',str(policy),'--check','/bin/sh','-c',check]
            work(cmd,env,before,after);assert (workspace/'note.txt').read_text()=='before '+after+'\n' and not server.failed
        assert server.phases==list(range(18))
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        views=[json.loads(line.removeprefix(b'EVENT VIEW ')) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
        assert status.returncode==0 and len(views)==1;view=views[0]
        assert view['work_phase']=='complete' and view['followup_phase']=='complete' and view['check_outcome']=='passed' and view['followup_check_outcome']=='passed'
        contents=[json.loads(event['text']) for event in view['work_events']]
        assert FIRST_TASK in contents and FIRST_SUMMARY in contents and CHILD in contents and READ_SUMMARY in contents and any('绿色' in value for value in contents)
        with sqlite3.connect(state/'history.sqlite3') as db:assert db.execute('pragma integrity_check').fetchone()==('ok',)
        resumed=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(current),'--state',str(state),'--allow','context.txt','--once','解释两次结果','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        assert resumed.returncode==0 and server.phases==list(range(22)) and not server.failed
        print(json.dumps({'status':'passed','scope':'synthetic UTF-8 chat, work, followup and continuation','fake_requests':22,'fresh_confirmations':2,'workspace':'before gold','checks':'passed'}))
    finally:server.shutdown();server.server_close();thread.join(timeout=5);shutil.rmtree(out)

if __name__=='__main__':main()
