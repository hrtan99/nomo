#!/usr/bin/env python3
"""Two confirmed synthetic edits with multilingual read evidence and continuation."""
import json,os,pty,select,shutil,signal,sqlite3,subprocess,tempfile,termios,threading,time
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
MODE=os.environ.get('SYNTHETIC_SUMMARY_MODE','full')
BASELINE=os.environ.get('SYNTHETIC_BUDGET_BASELINE')
FILES=['context.txt','second.txt','third.txt','fourth.txt']
FIRST_TASK=('Change old to green '+ '\\'*108) if MODE=='escaped' else '请将 old 替换为 green'
SECOND_TASK=('Change green to gold '+ '\\'*107) if MODE=='escaped' else 'Change green to gold using context'
DELEGATE='读取 context.txt 中的颜色；'+'确认颜色并保留相关上下文。'*5
CHILD='当前颜色是绿色'
READ_SUMMARY='文件内容是绿色'
FALLBACK='Edit applied; model summary unavailable (blank or over limit).'
FIRST_SUMMARY=FALLBACK if MODE=='fallback' else (chr(1)*1023+'X' if MODE=='escaped' else '界'*341+'a')
MODEL_FIRST_SUMMARY='X'*1025 if MODE=='fallback' else FIRST_SUMMARY
FIRST_SOURCE='system' if MODE=='fallback' else 'model'
SECOND_SUMMARY='界'*341+'a'
INITIAL_QUESTION='\\'*128 if MODE=='escaped' else '读取初始颜色'
INITIAL_TASK='\\'*128 if MODE=='escaped' else '读取 context.txt'
INITIAL_RESULT='\\'*160 if MODE=='escaped' else '初始颜色为蓝色'
INITIAL_ANSWER='\\'*250 if MODE=='escaped' else '初始颜色为蓝色'

LONG_TASK='界'*170+'aa'  # exactly 512 UTF-8 bytes
MULTI=MODE in ('multi','chat-long')

class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer SYNTHETIC_ONLY'
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.phases)
            limits=[2048,2048,2048,2048,2048,4096,4096,2048,4096,32768,2048,2048,4096,4096,2048,4096,32768,2048,2048,2048,2048,2048]
            if MODE=='third':limits=limits[:18]+[2048,4096,4096,2048,4096,32768,2048,2048,2048,2048,2048]
            if BASELINE:limits[5:7]=[2048,2048]
            assert req['max_tokens']==limits[i]
            if MULTI and i in (1,5,12,19):assert ctx['allowed']==FILES
            if (MODE=='resume-action' and i==19) or (MODE=='resume-final' and i==20):
                self.server.phases.append(i);self.send_error(503);return
            if MODE=='work-length' and i==5:
                cap=2048 if BASELINE else 4096
                data=json.dumps({'choices':[{'message':{'role':'assistant','content':''},'finish_reason':'length'}], 'usage':{'prompt_tokens':100,'completion_tokens':cap,'total_tokens':cap+100}}).encode()
                self.server.phases.append(i);self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
            if i==0:value=['delegate',LONG_TASK if MODE=='chat-long' else INITIAL_TASK]
            elif i==1:
                if MODE=='chat-long':assert ctx['history'][-1]['text']==LONG_TASK
                value=['search','marker',*FILES] if MULTI else ['read','context.txt']
            elif i==2:value=['final',INITIAL_RESULT]
            elif i==3:value=INITIAL_ANSWER
            elif i==4:
                assert ctx['current']['request']==FIRST_TASK and ctx['previous']['answer']==INITIAL_ANSWER;value=['delegate',DELEGATE]
            elif i==5:value=['read','context.txt']
            elif i==6:value=['final',CHILD]
            elif i==7:
                assert ctx['current']['task']==DELEGATE and ctx['current']['result']==CHILD and '绿色' in ctx['current']['outcome'];value=READ_SUMMARY
            elif i==8:
                evidence=ctx['current']['evidence'];assert evidence['request']==FIRST_TASK and evidence['task']==DELEGATE and evidence['result']==CHILD and evidence['summary']==READ_SUMMARY and '绿色' in evidence['outcome']
                value=['delegate','把 old 替换为 green']
            elif i==9:value=['edit','old','green']
            elif i==10:
                assert ctx['current']['edit']['after']=='before green\n';value=MODEL_FIRST_SUMMARY
            elif i==11:
                self.server.read_context_bytes=len(req['messages'][1]['content'].encode('utf-8'))
                if MODE=='escaped':assert 8192 < self.server.read_context_bytes <= 16384
                assert ctx['current']['request']==SECOND_TASK and ctx['prior_work']['summary']==FIRST_SUMMARY and ctx['prior_work']['summary_source']==FIRST_SOURCE;value=['delegate','Read context.txt for the color']
            elif i==12:value=['search','marker',*FILES] if MULTI else ['read','context.txt']
            elif i==13:value=['final',CHILD]
            elif i==14:
                assert ctx['current']['result']==CHILD and ('fourth.txt:1' if MULTI else '绿色') in ctx['current']['outcome'];value=READ_SUMMARY
            elif i==15:
                assert ctx['prior_work']['summary']==FIRST_SUMMARY and ctx['prior_work']['summary_source']==FIRST_SOURCE and ctx['current']['evidence']['summary']==READ_SUMMARY;value=['delegate','Replace green with gold']
            elif i==16:value=['edit','green','gold']
            elif i==17:value=SECOND_SUMMARY
            elif MODE=='third' and i==18:
                assert ctx['prior_work']['summary']==SECOND_SUMMARY;value=['delegate','Read context.txt']
            elif MODE=='third' and i==19:value=['read','context.txt']
            elif MODE=='third' and i==20:value=['final',CHILD]
            elif MODE=='third' and i==21:value=READ_SUMMARY
            elif MODE=='third' and i==22:value=['delegate','Replace gold with plum']
            elif MODE=='third' and i==23:value=['edit','gold','plum']
            elif MODE=='third' and i==24:value='第三次编辑完成'
            elif MODE=='third' and i==25:
                assert ctx['budget']['work_calls']==21 and ctx['budget']['work_generation']==153600
                assert ctx['additional'][0]['id']=='edit3' and ctx['additional'][0]['summary']=='第三次编辑完成';value=['delegate','Read context.txt']
            elif MODE=='third' and i==26:value=['read','context.txt']
            elif MODE=='third' and i==27:value=['final','记录完整']
            elif MODE=='third' and i==28:value='三次编辑均已记录'
            elif i==18:
                assert ctx['budget']['work_calls']==14 and ctx['budget']['work_generation']==(98304 if BASELINE else 102400)
                assert ctx['work']['summary']==FIRST_SUMMARY and ctx['work']['summary_source']==FIRST_SOURCE and ctx['followup']['summary']==SECOND_SUMMARY and ctx['followup']['summary_source']=='model';value=['delegate',LONG_TASK if MODE=='chat-long' else 'Read context.txt']
            elif i==19:
                if MODE=='chat-long':assert ctx['history'][-1]['text']==LONG_TASK
                value=['read','fourth.txt' if MULTI else 'context.txt']
            elif i==20:value=['final','记录完整']
            elif i==21:value='两次编辑均已记录'
            else:raise AssertionError('unexpected extra request')
            content=json.dumps(value,ensure_ascii=False,separators=(',',':')) if isinstance(value,list) else value
            usage={'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}
            if MODE=='work-native-action' and i==5:usage={'prompt_tokens':16000,'completion_tokens':265,'total_tokens':16265}
            if MODE=='work-native-final' and i==6:usage={'prompt_tokens':24000,'completion_tokens':337,'total_tokens':24337}
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                             'usage':usage},ensure_ascii=False).encode()
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
    old=out/'old'
    if BASELINE:
        shutil.copytree(Path(BASELINE),old,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__','.pytest_cache'));(old/'.etas').mkdir(mode=0o700)
    else:old=project
    context=out/'context';context.mkdir(mode=0o700);(context/'context.txt').write_text('\\'*120 if MODE=='escaped' else '蓝色 blue\n')
    current=out/'current';current.mkdir(mode=0o700);(current/'context.txt').write_text('绿色 green\n')
    if MULTI:
        for root in (context,current):
            for name in FILES[1:]: (root/name).write_text('marker '+name+'\n')
    workspace=out/'workspace';workspace.mkdir(mode=0o700);(workspace/'note.txt').write_text('before old\n')
    state=out/'state';state.mkdir(mode=0o700);policy=out/'policy';policy.mkdir(mode=0o700)
    (policy/'policy.json').write_text('{"format":1,"literals":["SYNTHETIC_NEVER_PRESENT"]}');(policy/'policy.json').chmod(0o600)
    (policy/'binding.key').write_bytes(b'K'*32);(policy/'binding.key').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        for selected in (project,old) if BASELINE else (project,):
            manifest=selected/'etas.toml';text=manifest.read_text()
            for name in ('nomo-read-events-new','nomo-read-events-existing','nomo-history-events-work'):
                start=text.index('[runtime.profiles.'+name+'.model]');end=text.index('[runtime.profiles.'+name+'.model.timeout]',start)
                part=text[start:end].replace('https://api.minimax.cn/v1','http://host.docker.internal:%d/v1'%server.server_port).replace('allow_private = false','allow_private = true');text=text[:start]+part+text[end:]
            manifest.write_text(text)
        env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.2.5'}
        allowed=','.join(FILES) if MULTI else 'context.txt'
        first=subprocess.run([str(old/'scripts/nomo-read.sh'),'session-new','--root',str(context),'--state',str(state),'--allow',allowed,'--once',INITIAL_QUESTION,'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        if first.returncode:raise AssertionError('synthetic initial chat failed: '+first.stderr.decode('utf-8','replace')[-2000:])
        assert server.phases==list(range(4)) and not server.failed
        if MODE in ('work-length','work-native-action','work-native-final'):
            cmd=[str(old/'scripts/nomo-read.sh'),'session-work','--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id','edit1','--path','note.txt','--allow',allowed,'--once',FIRST_TASK,'--events-policy-dir',str(policy)]
            master,slave=pty.openpty();proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
            output=bytearray();deadline=time.monotonic()+120
            while proc.poll() is None:
                if time.monotonic()>deadline:os.killpg(proc.pid,signal.SIGTERM);raise TimeoutError('work length probe timeout')
                if select.select([master],[],[],.1)[0]:
                    try:output.extend(os.read(master,65536))
                    except OSError:pass
            os.close(master)
            expected_calls=7 if MODE=='work-native-final' else 6
            assert proc.returncode==3 and server.phases==list(range(expected_calls)) and not server.failed
            assert b'PREVIEW ' not in output and (workspace/'note.txt').read_text()=='before old\n'
            status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
            views=[json.loads(line.removeprefix(b'EVENT VIEW ')) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
            reserved=47104 if BASELINE else 51200
            assert status.returncode==0 and len(views)==1 and views[0]['work_phase']=='running' and views[0]['work_reserved_tokens']==reserved
            print(json.dumps({'status':'passed','scope':'synthetic child limit failure; no preview, edit or retry','mode':MODE,'fake_requests':expected_calls,'reserved_tokens':reserved}));return
        for action,identifier,before,after,task in [('session-work','edit1','old','green',FIRST_TASK),('session-followup','edit2','green','gold',SECOND_TASK)]:
            check='test "$(cat note.txt)" = "before '+after+'" && printf CHECK_OK'
            selected=old if action=='session-work' else project
            cmd=[str(selected/'scripts/nomo-read.sh'),action,'--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id',identifier,'--path','note.txt','--allow',allowed,'--once',task,'--events-policy-dir',str(policy),'--check','/bin/sh','-c',check]
            work(cmd,env,before,after);assert (workspace/'note.txt').read_text()=='before '+after+'\n' and not server.failed
        assert server.phases==list(range(18))
        if MODE=='third':
            check='test "$(cat note.txt)" = "before plum" && printf CHECK_OK'
            cmd=[str(project/'scripts/nomo-read.sh'),'session-followup','--read-root',str(current),'--root',str(workspace),'--state',str(state),'--id','edit3','--path','note.txt','--allow',allowed,'--once','Change gold to plum using context','--events-policy-dir',str(policy),'--check','/bin/sh','-c',check]
            work(cmd,env,'gold','plum');assert (workspace/'note.txt').read_text()=='before plum\n' and not server.failed
            assert server.phases==list(range(25))
        status=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        views=[json.loads(line.removeprefix(b'EVENT VIEW ')) for line in status.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
        assert status.returncode==0 and len(views)==1;view=views[0]
        assert view['work_phase']=='complete' and view['followup_phase']=='complete' and view['check_outcome']=='passed' and view['followup_check_outcome']=='passed'
        assert view['work_settled_calls']==7 and view['followup_settled_calls']==7
        assert view['work_settled_tokens']==(47104 if BASELINE else 51200) and view['followup_settled_tokens']==51200
        if MODE=='third':assert len(view['additional_work'])==1 and view['additional_work'][0]['check']['phase']=='complete' and view['additional_work'][0]['result']['generation']==51200
        if MODE=='chat-long':assert any(event['kind']=='delegate' and json.loads(event['text'])==LONG_TASK for event in view['events'])
        contents=[json.loads(event['text']) for event in view['work_events']]
        assert FIRST_TASK in contents and FIRST_SUMMARY in contents and CHILD in contents and READ_SUMMARY in contents and any('绿色' in value for value in contents)
        assert any(json.loads(event['text'])==FIRST_SUMMARY and event['role']==('system' if MODE=='fallback' else 'assistant') and event['kind']==('notice' if MODE=='fallback' else 'answer') for event in view['work_events'])
        with sqlite3.connect(state/'history.sqlite3') as db:assert db.execute('pragma integrity_check').fetchone()==('ok',)
        resumed=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-continue','--root',str(current),'--state',str(state),'--allow',allowed,'--once','解释两次结果','--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
        if MODE in ('resume-action','resume-final'):
            expected='chat-child-action' if MODE=='resume-action' else 'chat-child-final'
            output=resumed.stdout+b'\n'+resumed.stderr
            assert resumed.returncode==3 and not server.failed
            assert ('last_stage_text='+expected+' text_marker=provider_http_503').encode() in output
            assert server.phases==list(range(20 if MODE=='resume-action' else 21)) and (workspace/'note.txt').read_text()=='before gold\n'
            after=subprocess.run([str(project/'scripts/nomo-read.sh'),'session-status','--state',str(state),'--events-policy-dir',str(policy)],env=env,capture_output=True,timeout=120)
            items=[json.loads(line.removeprefix(b'EVENT VIEW ')) for line in after.stdout.splitlines() if line.startswith(b'EVENT VIEW {')]
            assert after.returncode==0 and len(items)==1 and items[0]['phase']=='running' and items[0]['reserved_calls']==4
            assert items[0]['work_phase']=='complete' and items[0]['followup_phase']=='complete'
            print(json.dumps({'status':'passed','scope':'synthetic resume child failure; no retry or real provider','stage':expected,'fake_requests':len(server.phases)}));return
        if resumed.returncode:
            markers=[line.decode('utf-8','replace') for line in (resumed.stdout+resumed.stderr).splitlines() if line.startswith((b'REFUSED ',b'error[',b'Runtime diagnostic'))]
            raise AssertionError('synthetic continuation exit='+str(resumed.returncode)+' phases='+str(server.phases)+' markers='+str(markers[-4:]))
        expected=29 if MODE=='third' else 22
        assert resumed.returncode==0 and server.phases==list(range(expected)) and not server.failed
        print(json.dumps({'status':'passed','scope':'synthetic UTF-8 chat, work, followup and continuation','fake_requests':expected,'fresh_confirmations':3 if MODE=='third' else 2,'workspace':'before plum' if MODE=='third' else 'before gold','checks':'passed','followup_context_bytes':server.read_context_bytes}))
    finally:server.shutdown();server.server_close();thread.join(timeout=5);shutil.rmtree(out)

if __name__=='__main__':main()
