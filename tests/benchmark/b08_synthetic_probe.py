#!/usr/bin/env python3
"""B08 synthetic-provider CLI regression, not a real-model benchmark."""
import argparse,importlib.util,json,os,pty,re,select,shutil,signal,sqlite3,subprocess,sys,tempfile,termios,threading,time
from contextlib import closing
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('fixture',ROOT/'tests/benchmark/benchmark.py');fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
PROMPT='Change the default timeout to 45 seconds in config/app.toml.'
BEFORE='[service]\ntimeout_seconds = 30\n';AFTER='[service]\ntimeout_seconds = 45\n'
TOKEN='SYNTHETIC_ONLY';MAX_OUTPUT=131072

class Provider(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  try:
   size=int(self.headers.get('Content-Length','0'));assert 0<size<=131072
   payload=json.loads(self.rfile.read(size));assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer '+TOKEN
   context=json.loads(payload['messages'][1]['content']);ordinal=len(self.server.phases)
   assert ordinal in (0,1) and context['phase']==('plan' if ordinal==0 else 'child')
   if ordinal==0:
    assert context['request']==PROMPT and context['before']==BEFORE
    response=['delegate','Change the timeout setting to 45 seconds']
   else:response=['edit','timeout_seconds = 30','timeout_seconds = 45']
   self.server.phases.append(context['phase'])
   encoded=json.dumps({'choices':[{'message':{'role':'assistant','content':json.dumps(response,separators=(',',':'))},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14}}).encode()
   self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded)
  except Exception as error:
   self.server.failure=type(error).__name__
   try:self.send_error(500)
   except (BrokenPipeError,ConnectionResetError):pass

def journal_state(state,forensics):
 db=state/'edit.sqlite3'
 if not db.exists():return {'database':'absent','operation_entries':0}
 forensics.mkdir(mode=0o700)
 for suffix in ('','-wal','-shm'):
  source=Path(str(db)+suffix)
  if source.exists():shutil.copyfile(source,forensics/('edit.sqlite3'+suffix))
 uri=(forensics/'edit.sqlite3').resolve().as_uri()+'?mode=ro'
 try:
  with closing(sqlite3.connect(uri,uri=True,timeout=2)) as c:
   integrity=c.execute('PRAGMA integrity_check').fetchone();found=c.execute("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='memory_entries'").fetchone()[0]
   count=c.execute("SELECT count(*) FROM memory_entries WHERE region='nomo-edit-operation-v1'").fetchone()[0] if found else 0
  return {'database':'copied_readonly','integrity_ok':integrity==('ok',),'operation_entries':count}
 except sqlite3.Error as e:
  return {'database':'inspection_error','sqlite_errorname':getattr(e,'sqlite_errorname',None)}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--output-dir',type=Path,required=True);args=parser.parse_args()
 args.output_dir.mkdir(mode=0o700,parents=True,exist_ok=True)
 out=Path(tempfile.mkdtemp(prefix='b08-',dir=args.output_dir));fixture.prepare('B08',out/'fixture');workspace=out/'fixture/workspace';state=out/'fixture/state'
 initial=fixture.snapshot(workspace);expected=fixture.expected_snapshot(fixture.files_for('B08'));assert initial==expected
 baseline=subprocess.run([sys.executable,'-B','-m','unittest','discover','-s','tests','-q'],cwd=workspace,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,env={'PATH':os.defpath,'PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1'})
 (out/'baseline.stdout').write_bytes(baseline.stdout);(out/'baseline.stderr').write_bytes(baseline.stderr)
 if baseline.returncode!=0 or fixture.snapshot(workspace)!=initial:
  (out/'result.json').write_text(json.dumps({'scope':'synthetic fixture baseline','benchmark_status':'not_run','regression_status':'failed','baseline_exit':baseline.returncode},indent=2)+'\n');print(json.dumps({'evidence':str(out),'regression_status':'failed','benchmark_status':'not_run'}));return 1
 provider=HTTPServer(('127.0.0.1',0),Provider);provider.phases=[];provider.failure=None;thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
 env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'NOMO_MODEL_PROVIDER':'qwen','NOMO_READ_MODEL_BASE_URL':'http://host.docker.internal:'+str(provider.server_port)+'/v1','NOMO_QWEN_SERVER_API_KEY':TOKEN,'NOMO_ETAS_VERSION':'0.2.5'}
 cmd=[str(ROOT/'scripts/nomo-read.sh'),'edit','--root',str(workspace),'--state',str(state),'--id','b08denied','--path','config/app.toml','--once',PROMPT]
 master,slave=pty.openpty();settings=termios.tcgetattr(slave);settings[3]&=~(termios.ECHO|termios.ECHONL);settings[1]&=~termios.ONLCR;termios.tcsetattr(slave,termios.TCSANOW,settings)
 proc=None;output=bytearray();answered=False;preview_verified=False;started=time.monotonic();failure=None
 try:
  proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);slave=None;deadline=time.monotonic()+120
  while proc.poll() is None:
   if time.monotonic()>deadline:raise TimeoutError('deadline')
   if select.select([master],[],[],.1)[0]:
    try:chunk=os.read(master,16384)
    except OSError:chunk=b''
    output.extend(chunk)
    if len(output)>MAX_OUTPUT:raise ValueError('terminal output limit')
   if not answered and b'Type `yes` to approve:' in output:
    lines=[line.removeprefix(b'PREVIEW ') for line in bytes(output).splitlines() if line.startswith(b'PREVIEW ')]
    assert len(lines)==1
    preview=json.loads(lines[0]);preview_verified=(preview['path']=='config/app.toml' and preview['before']==BEFORE and preview['after']==AFTER and preview['target']=='timeout_seconds = 30' and preview['replacement']=='timeout_seconds = 45')
    assert preview_verified
    os.write(master,b'n\n');answered=True
  while select.select([master],[],[],0)[0]:
   try:chunk=os.read(master,16384)
   except OSError:break
   if not chunk:break
   output.extend(chunk)
   if len(output)>MAX_OUTPUT:raise ValueError('terminal output limit')
 except BaseException as e:failure=type(e).__name__
 finally:
  if proc and proc.poll() is None:
   try:os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=25)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
  if slave is not None:os.close(slave)
  os.close(master);provider.shutdown();provider.server_close();thread.join(timeout=5)
 (out/'work.terminal').write_bytes(output)
 actual=fixture.snapshot(workspace);journal=journal_state(state,out/'forensic-copy')
 checks={'exact_fixture_before':initial==expected,'preview_exact':preview_verified,'native_approval_requested':answered,
         'answer_n_sent':answered,'exit_nonzero':proc is not None and proc.returncode not in (None,0),
         'denial_visible':b'native approval denied' in output.lower(),'no_later_application_confirmation':b'CONFIRM Apply this exact preview?' not in output,
         'workspace_byte_tree_unchanged':actual==initial,'no_retained_edit_intent':journal.get('operation_entries')==0,
         'provider_two_calls':provider.phases==['plan','child'] and provider.failure is None,'no_check_option_given':'--check' not in cmd}
 result={'scope':'synthetic-provider real CLI B08 denial path only','benchmark_status':'not_run','real_provider':False,
         'product_revision':'f596e4a','etas_version':'0.2.5','task_id':'B08','prompt_exact':True,'failure':failure,
         'baseline_exit':baseline.returncode,'exit_code':proc.returncode if proc else None,'elapsed_seconds':round(time.monotonic()-started,3),'checks':checks,
         'journal':journal,'model_request_phases':provider.phases,'provider_failure':provider.failure,'initial_snapshot':initial,'final_snapshot':actual,
         'unassessed':['real_provider_and_benchmark','prior_session_approval_history','persisted_conversation','complete_model_usage','full_event_provenance','independent_command_effect_trace']}
 (out/'result.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
 print(json.dumps({'evidence':str(out),'regression_status':'passed' if failure is None and all(checks.values()) else 'failed','benchmark_status':'not_run'}))
 return 0 if failure is None and all(checks.values()) else 1
if __name__=='__main__':raise SystemExit(main())
