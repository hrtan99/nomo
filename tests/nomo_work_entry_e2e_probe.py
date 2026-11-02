#!/usr/bin/env python3
"""One owned synthetic end-to-end check of the user work launcher."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import argparse,json,os,pty,select,signal,subprocess,tempfile,termios,threading,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
TOKEN='SYNTHETIC_WORK_ENTRY_ONLY'
class Fake(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer '+TOKEN
            n=int(self.headers['Content-Length']);assert 0<n<=196608
            req=json.loads(self.rfile.read(n));ctx=json.loads(req['messages'][1]['content']);i=len(self.server.phases)
            assert i<7 and req['max_tokens']==[2048,2048,2048,2048,4096,32768,2048][i]
            if i==0: value=['delegate','Read context.txt']
            elif i==1: value=['read','context.txt']
            elif i==2:
                seen=[x['text'] for x in ctx['history'] if x['role']=='tool' and x['kind']=='complete']
                assert seen==['complete: blue'];value=['final','Seen: '+seen[0]]
            elif i==3:
                assert ctx['outcome']=='complete: blue';value='Summary: '+ctx['outcome']
            elif i==4:
                assert ctx['edit']['before']=='before old\n' and ctx['evidence']['outcome']=='complete: blue'
                value=['delegate','replace old with blue']
            elif i==5:
                assert ctx['evidence']['outcome']=='complete: blue';value=['edit','old','blue']
            else:
                assert ctx['edit']['after']=='before blue\n' and ctx['edit']['completed'] is True
                value='Edit completed using the selected context.'
            content=json.dumps(value,separators=(',',':')) if isinstance(value,list) else value
            self.server.phases.append(i)
            data=json.dumps({'choices':[{'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
                             'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14}}).encode()
            self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception:
            self.server.failed=True
            try:self.send_error(500)
            except OSError:pass

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--evidence-dir',type=Path,required=True);args=parser.parse_args()
    args.evidence_dir.mkdir(parents=True,exist_ok=True);out=Path(tempfile.mkdtemp(prefix='work-entry-',dir=args.evidence_dir))
    workspace=out/'workspace';state=out/'state';context=out/'context'
    for p in (workspace,state,context):p.mkdir(mode=0o700)
    (workspace/'note.txt').write_bytes(b'before old\n');(workspace/'note.txt').chmod(0o600)
    (context/'context.txt').write_text('blue');(context/'context.txt').chmod(0o600)
    server=HTTPServer(('127.0.0.1',0),Fake);server.phases=[];server.failed=False
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    env=os.environ.copy();env.update(NOMO_READ_MODEL_BASE_URL='http://host.docker.internal:%d/v1'%server.server_port,
                                     NOMO_QWEN_SERVER_API_KEY=TOKEN)
    cmd=[str(ROOT/'scripts/nomo-read.sh'),'work','--read-root',str(context),'--allow','context.txt',
         '--root',str(workspace),'--state',str(state),'--id','owned-edit','--path','note.txt','--once','Update old using context',
         '--check','/bin/sh','-c','test "$(cat note.txt)" = "before blue"']
    master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(slave,termios.TCSANOW,settings)
    proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
    output=bytearray();native=False;application=False;result={'status':'failed','scope':'synthetic work entry'}
    try:
        deadline=time.monotonic()+120
        while proc.poll() is None:
            if time.monotonic()>deadline:raise TimeoutError()
            if select.select([master],[],[],.1)[0]:
                try:output.extend(os.read(master,65536))
                except OSError:pass
            if not native and b'Type `yes` to approve:' in output:
                previews=[line.removeprefix(b'PREVIEW ') for line in bytes(output).splitlines() if line.startswith(b'PREVIEW ')]
                assert len(previews)==1;v=json.loads(previews[0]);assert v['path']=='note.txt' and v['before']=='before old\n' and v['target']=='old' and v['replacement']=='blue' and v['after']=='before blue\n'
                assert b'WARNING File permissions, including executable bits, may change during this edit.' in output
                os.write(master,b'yes\n');native=True
            if not application and b'CONFIRM Apply this exact preview? [y/N]' in output:
                assert native;os.write(master,b'yes\n');application=True
        while select.select([master],[],[],0)[0]:
            try:part=os.read(master,65536)
            except OSError:break
            if not part:break
            output.extend(part)
        assert proc.returncode==0 and not server.failed and server.phases==list(range(7))
        assert native and application and (workspace/'note.txt').read_bytes()==b'before blue\n'
        assert (context/'context.txt').read_text()=='blue' and b'Check passed.' in output and b'FINAL ' in output
        listing=subprocess.run(['docker','ps','-aq','--filter','label=nomo.terminal.invocation'],capture_output=True,text=True,timeout=5,check=True)
        for ident in listing.stdout.split():
            inspected=subprocess.run(['docker','inspect','--format','{{json .Mounts}}',ident],capture_output=True,text=True,timeout=5)
            if inspected.returncode:continue
            mounts={v['Destination']:v for v in json.loads(inspected.stdout)}
            assert mounts.get('/edit-fixture',{}).get('Source') not in (str(workspace),'/host_mnt'+str(workspace))
        result.update(status='passed',exit=proc.returncode,phases=server.phases,native_approval=native,application_approval=application,
                      file_expected=True,context_unchanged=True,check_passed=True,matching_container_absent=True)
    except BaseException as e:result.update(failure_type=type(e).__name__,exit=proc.poll(),phases=server.phases)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid,signal.SIGTERM)
            try:proc.wait(timeout=20)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
        os.close(master);server.shutdown();server.server_close();thread.join(timeout=5)
        if thread.is_alive() or server.failed:result['status']='failed';result['server_failed']=True
        (out/'output.bin').write_bytes(output);(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'status':result['status'],'evidence':str(out)}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
