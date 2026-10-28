#!/usr/bin/env python3
"""Explicit bounded Qwen qualification; prepare/controls never execute an Agent.

Runtime requires the separately approved invocation ledger and existing private
configuration. The relay observes the native wire without rewriting it. No work
fixture, database, file capability, application tool or outer retry is supplied.
"""
import argparse
import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import uuid

ROOT = Path(__file__).resolve().parent.parent
BASE = '471fa61c376aad9de7a253c5e46552c2f530b884'
from native_typed_model001_probe import MODULES

MANIFEST = '''[package]
name = "typed-work-backend-qualification"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "probe"
[runtime.profiles.probe]
boundary_policy = "typed-work-backend-qualification"
[runtime.profiles.probe.model]
adapter = "omlx-openai"
model = "__MODEL__"
base_url = "http://host.docker.internal:18095/v1"
api_key_env = "NOMO_QWEN_SERVER_API_KEY"
allow_private = true
enable_thinking = false
[runtime.profiles.probe.model.timeout]
request_deadline_ms = 30000
connect_timeout_ms = 5000
[runtime.profiles.probe.model.retry]
attempts = 1
delay_ms = 0
[runtime.profiles.probe.policy]
mode = "local-static"
rules = ["console=allow", "model=allow"]
[runtime.profiles.probe.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.typed_backend_probe"
flow = "observe"
profile = "probe"
'''


def save(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n')


def prepare(parent):
    folder = Path(tempfile.mkdtemp(prefix='typed-backend-', dir=parent)).resolve()
    project = folder/'project'; (project/'src/app').mkdir(parents=True)
    sources = {}
    for name in MODULES:
        relative = 'src/nomo/'+name
        data = subprocess.check_output(['git', 'show', BASE+':'+relative], cwd=ROOT)
        target = project/relative; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        sources[relative] = hashlib.sha256(data).hexdigest()
    fixture = ROOT/'tests/fixtures/typed_work001/backend_probe.es'
    shutil.copyfile(fixture, project/'src/app/typed_backend_probe.es')
    model = tomllib.loads((ROOT/'etas.toml').read_text())['runtime']['profiles']['work-chain']['model']['model']
    (project/'etas.toml').write_text(MANIFEST.replace('__MODEL__', model))
    save(folder/'preparation.json', dict(scope='Dedicated static synthetic Context, exactly one explicit typed inference; controls do not run observe',
        accepted_component_base=BASE, accepted_sources=sources, fixture_sha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),
        caps=dict(generation_per_request=2048, native_run_seconds=170, outer_process_seconds=165, total_seconds=180, transport_ms=30000,
                  HTTP_attempts_per_request=1, max_native_and_HTTP_requests=9), Model_calls=0))
    print(folder)
    return folder


def container_controls(folder):
    from normal_graph_identity import verify_cli
    from model_protocol_probe import resources
    cli = verify_cli(); project = folder/'project'; results = []
    for label, argv in [('check', [cli, 'check', '--all', project]),
                         ('signature-effects', [cli, 'effects', project, '--flow', 'infer_signature']),
                         ('observer-effects', [cli, 'effects', project, '--flow', 'observe']),
                         ('effective-profile', [cli, 'run', project, '--flow', 'observe', '--profile', 'probe', '--budget-time', '170s', '--print-runtime-profile'])]:
        run = subprocess.run(list(map(str, argv)), capture_output=True, timeout=120)
        (folder/(label+'.stdout.bin')).write_bytes(run.stdout); (folder/(label+'.stderr.bin')).write_bytes(run.stderr)
        item = dict(label=label, command=list(map(str, argv)), exit=run.returncode, stdout=run.stdout.decode(), stderr=run.stderr.decode())
        results.append(item); save(folder/'controls.json', dict(status='checking', commands=results, Model_calls=0))
        assert run.returncode == 0 and not run.stderr, item
        if label.endswith('effects'):
            assert 'Agentic.infer[app.typed_backend_probe.BackendProbe.run, nomo.tools.edit_contribution.Contribution]' in item['stdout']
            assert not any(x in item['stdout'] for x in ['Memory.', 'Approval.', 'Fs.', 'Console.stdin'])
            if label == 'signature-effects': assert 'Console.' not in item['stdout']
    profile = results[-1]['stdout']
    save(folder/'controls.json', dict(status='source/effects/effective-profile observed; TL review before run', commands=results,
        resources=resources(), actual_native_run_argv=['etas','run',str(project),'--flow','observe','--profile','probe','--budget-time','170s','--allow-effects','--trace-out',str(folder/'native.trace.json')],
        qualification='Runtime profile does not display or prove source Tokens/deadline; retain source/argv separately.', Model_calls=0))
    print('PASS controls only; zero Model')


def compose(folder, *, name=None):
    command = ['docker','compose','--env-file','/dev/null','-f','compose.yaml','-f','config/etas-runtime-cache-compose.yaml','-f','config/local-tryout-compose.yaml']
    command += ['run','--rm','--no-deps','--pull','never','--tty=false']
    if name: command += ['--name',name,'--label','nomo.typed.probe='+name]
    command += ['-e','PYTHONDONTWRITEBYTECODE=1','-e','ETAS_HOST_MODEL_RETRY_ATTEMPTS=1','-e','ETAS_HOST_MODEL_RETRY_DELAY_MS=0',
                '-e','ETAS_HOST_MODEL_REQUEST_DEADLINE_MS=30000','-e','ETAS_HOST_MODEL_CONNECT_TIMEOUT_MS=5000','-v',str(folder)+':/probe-evidence']
    return command


def controls(folder):
    command = compose(folder)+['dev','python3','/workspace/tests/typed_work_backend_probe.py','--stage','container-controls','--folder','/probe-evidence']
    run = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=240)
    (folder/'controls-container.stdout.bin').write_bytes(run.stdout);(folder/'controls-container.stderr.bin').write_bytes(run.stderr)
    save(folder/'controls-container.json',dict(command=command,exit=run.returncode));print(run.stdout.decode());print(run.stderr.decode());assert run.returncode==0


def execute(folder, private_env, ssh_host, ledger):
    # Called only after independent TL review of this exact source/effective controls.
    cfg = {}
    for line in private_env.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            name, value = line.removeprefix('export ').split('=',1);cfg[name.strip()] = shlex.split(value)[0]
    key = cfg['NOMO_QWEN_SERVER_API_KEY'];assert key
    state = json.loads(ledger.read_text());assert state['A']['probe_invocations']==0, 'A second invocation requires concrete fix and TL review, not this runner'
    assert json.loads((folder/'controls.json').read_text())['Model_calls']==0
    expected_model = tomllib.loads((folder/'project/etas.toml').read_text())['runtime']['profiles']['probe']['model']['model']
    assert cfg['NOMO_QWEN_SERVER_MODEL']==expected_model
    state['A'].update(probe_invocations=1,status='reserved first actual invocation',
                      native_requests_reserved=9,HTTP_attempts_reserved=9);save(ledger,state)
    name='nomo-typed-probe-'+uuid.uuid4().hex[:20]
    record=dict(status='starting',owned_container=name,requests=[],Model_source_inferences=1,
                refused_requests=0,header_observation='Only Content-Type/Encoding/Length values are archived; no authorization, cookie or secret header values',
                wire_qualification='Bodies and end-to-end headers pass unchanged. Connection-nominated/hop-by-hop headers are omitted and Content-Length is recomputed for unchanged buffered body bytes; no other header or body rewrite.')
    forward=None;server=None;thread=None;client=None;start=time.monotonic();deadline=start+180
    lock=threading.RLock();workers=[];stopping=threading.Event();violation=threading.Event()
    redactions={key};out=b'';err=b''
    hop_headers={'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length'}
    public_headers={'content-type','content-encoding','content-length'}

    def clean(value):
        with lock:tokens=sorted(redactions,key=len,reverse=True)
        for token in tokens:
            value=value.replace(token,'<redacted>')
            escaped=json.dumps(token,ensure_ascii=True)[1:-1]
            if escaped!=token:value=value.replace(escaped,'<redacted>')
        return value

    def redact(value):
        if isinstance(value,str):return clean(value)
        if isinstance(value,list):return [redact(item) for item in value]
        if isinstance(value,dict):return {clean(name) if isinstance(name,str) else name:redact(item) for name,item in value.items()}
        return value

    def headers(items):
        values=list(items);excluded=set(hop_headers)
        for header,value in values:
            lower=header.lower()
            if lower=='connection':excluded.update(part.strip().lower() for part in value.split(','))
            if lower in {'authorization','proxy-authorization','cookie','set-cookie'} and value:
                with lock:
                    redactions.add(value)
                    if lower in {'cookie','set-cookie'}:
                        # Set-Cookie attributes are not cookie secret values.
                        cookies=value.split(';') if lower=='cookie' else value.split(';',1)[:1]
                        for cookie in cookies:
                            if '=' in cookie:
                                secret=cookie.split('=',1)[1].strip().strip('"')
                                if secret:redactions.add(secret)
        forwarded=[(header,value) for header,value in values if header.lower() not in excluded]
        observed=[(header,clean(value)) for header,value in values if header.lower() in public_headers]
        return forwarded,observed

    def retain(snapshot=None):
        if snapshot is None:
            with lock:snapshot=copy.deepcopy(record)
        save(folder/'runtime.json',redact(snapshot))

    def capture(error):
        nonlocal out,err
        if error.output is not None:out=error.output
        if error.stderr is not None:err=error.stderr

    class RelayServer(ThreadingHTTPServer):
        daemon_threads=True
        def process_request(self, request, address):
            # Register before thread start, including peers blocked while reading headers.
            request.settimeout(min(30,max(.1,deadline-time.monotonic())))
            worker=dict(socket=request,upstream=None,upstream_socket=None,finished=threading.Event())
            def service():
                try:self.finish_request(request,address)
                except BaseException as error:
                    with lock:record.setdefault('handler_transport_errors',[]).append(clean(repr(error)))
                    violation.set()
                finally:
                    try:self.shutdown_request(request)
                    finally:worker['finished'].set()
            worker['thread']=threading.Thread(target=service,daemon=True)
            with lock:workers.append(worker)
            try:worker['thread'].start()
            except BaseException:
                worker['finished'].set();self.shutdown_request(request);raise

    class Relay(BaseHTTPRequestHandler):
        def log_message(self,*_args):pass
        def do_POST(self):
            with lock:
                worker=next(item for item in workers if item['socket'] is self.connection)
                refused=stopping.is_set() or len(record['requests'])>=9 or time.monotonic()>=deadline
                if refused:
                    record['refused_requests']+=1;entry=None
                else:
                    entry=dict(ordinal=len(record['requests'])+1,downstream_attempts=0)
                    record['requests'].append(entry)
            if refused:
                violation.set()
                try:self.send_error(502,'qualification request reservation exhausted')
                except (OSError,ValueError):pass
                return
            connection=None
            try:
                size=int(self.headers.get('Content-Length','0'));assert 0<size<=262144
                body=self.rfile.read(size);assert len(body)==size;request=json.loads(body)
                assert self.path=='/v1/chat/completions' and request['model']==expected_model
                assert 0<request['max_tokens']<=2048
                assert self.headers.get('Authorization')=='Bearer '+key
                request_headers,observed_headers=headers(self.headers.raw_items())
                with lock:entry.update(request=request,request_body_bytes=len(body),request_body_sha256=hashlib.sha256(body).hexdigest(),
                                       request_headers=observed_headers,authorization_matches_existing_secret=True)
                if entry['ordinal']==1:
                    script='import json;from pathlib import Path;print(json.dumps({n:Path("/sys/fs/cgroup/"+n).read_text().strip() for n in ["memory.max","memory.peak","memory.events","cpu.max","pids.max"]}))'
                    observed=subprocess.run(['docker','exec',name,'python3','-c',script],capture_output=True,text=True,check=True,timeout=min(5,max(.1,deadline-time.monotonic())))
                    limits=json.loads(observed.stdout)
                    with lock:record['runtime_resources']=limits
                    assert limits['memory.max']=='4294967296' and limits['cpu.max']=='400000 100000' and limits['pids.max']=='256'
                for tool in request.get('tools',[]):assert tool.get('function',{}).get('name')=='etas_emit_output','unexpected application tool'
                assert not stopping.is_set() and time.monotonic()<deadline
                connection=http.client.HTTPConnection('127.0.0.1',18096,timeout=min(30,max(.1,deadline-time.monotonic())))
                with lock:
                    assert not stopping.is_set()
                    worker['upstream']=connection;entry['downstream_attempts']=1
                connection.putrequest('POST',self.path,skip_host=True,skip_accept_encoding=True)
                for header,value in request_headers:connection.putheader(header,value)
                connection.putheader('Content-Length',str(len(body)));connection.endheaders(body)
                with lock:worker['upstream_socket']=connection.sock
                response=connection.getresponse();response_headers,observed_response_headers=headers(response.getheaders())
                data=response.read(1048577);assert len(data)<=1048576
                encoding=response.getheader('Content-Encoding','identity').strip().lower()
                with lock:entry.update(response_status=response.status,response_headers=observed_response_headers,
                    response_body_bytes=len(data),response_body_sha256=hashlib.sha256(data).hexdigest(),
                    response_body=clean(data.decode(errors='replace')) if encoding in ('','identity') else None,
                    response_body_qualification='Sanitized text only for identity encoding; encoded body bytes are forwarded unchanged and represented by length/hash.')
                self.send_response_only(response.status,response.reason)
                for header,value in response_headers:self.send_header(header,value)
                self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            except BaseException as error:
                with lock:entry['observer_error']=clean(repr(error))
                violation.set()
                try:self.send_error(502,'qualification relay stopped')
                except (OSError,ValueError):pass
            finally:
                if connection:connection.close()

    try:
        server=RelayServer(('127.0.0.1',18095),Relay)
        thread=threading.Thread(target=server.serve_forever,kwargs=dict(poll_interval=.05),daemon=True);thread.start()
        command=['ssh','-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=5','-L','127.0.0.1:18096:127.0.0.1:8095',ssh_host]
        forward=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
        record.update(owned_forward_pid=forward.pid,forward_command=command)
        ready=time.monotonic()+6
        while True:
            assert forward.poll() is None,'owned forward exited'
            current=subprocess.run(['lsof','-nP','-a','-p',str(forward.pid),'-iTCP:18096','-sTCP:LISTEN','-t'],capture_output=True,text=True,timeout=2)
            if str(forward.pid) in current.stdout.split():break
            assert time.monotonic()<ready,'owned forward listener not available';time.sleep(.05)
        command=compose(folder,name=name)
        # bridge is a transport overlay only; the profile still grants just Console/Model.
        command[command.index('run'):command.index('run')]=['-f','config/local-tryout-model-compose.yaml']
        command+=['-e','NOMO_QWEN_SERVER_API_KEY','dev','etas','run','/probe-evidence/project','--flow','observe','--profile','probe','--budget-time','170s','--allow-effects','--trace-out','/probe-evidence/native.trace.json']
        environment=dict(os.environ);environment['NOMO_QWEN_SERVER_API_KEY']=key
        record['actual_command']=command;retain()
        client=subprocess.Popen(command,cwd=ROOT,env=environment,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        process_deadline=min(start+165,deadline-15)
        while True:
            if violation.is_set():raise RuntimeError('qualification relay guard failed; stop this invocation')
            remaining=process_deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('outer165second process bound exceeded')
            try:out,err=client.communicate(timeout=min(.25,remaining));break
            except subprocess.TimeoutExpired as error:capture(error)
        record.update(exit=client.returncode,status='qualified' if client.returncode==0 and b'QUALIFIED ' in out else 'failed',elapsed_seconds=time.monotonic()-start)
    except BaseException as error:record.update(status='failed',failure=clean(repr(error)))
    finally:
        cleanup=[];stopping.set()
        def available(maximum):return max(.01,min(maximum,deadline-time.monotonic()))
        def bounded(command,maximum=3):
            try:return subprocess.run(command,capture_output=True,text=True,timeout=available(maximum))
            except BaseException as error:cleanup.append(clean(repr(error)));return None
        if server:
            stopper=threading.Thread(target=server.shutdown,daemon=True);stopper.start();stopper.join(timeout=available(1))
            if stopper.is_alive():cleanup.append('relay accept-loop shutdown unconfirmed')
            try:server.server_close()
            except BaseException as error:cleanup.append(clean(repr(error)))
        if thread:
            thread.join(timeout=available(1))
            if thread.is_alive():cleanup.append('relay accept thread unconfirmed')
        if client is not None:
            try:
                if client.poll() is None:
                    try:os.killpg(client.pid,signal.SIGTERM)
                    except ProcessLookupError:pass
                # Always collect once more, including a child that exited at a guard failure.
                try:out,err=client.communicate(timeout=available(1))
                except subprocess.TimeoutExpired as error:
                    capture(error)
                    try:os.killpg(client.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    try:out,err=client.communicate(timeout=available(1))
                    except subprocess.TimeoutExpired as final_error:capture(final_error);cleanup.append('owned client termination unconfirmed')
                if client.poll() is None:cleanup.append('owned client still running')
            except BaseException as error:cleanup.append(clean(repr(error)))
        inspect=bounded(['docker','inspect','--format','{{.Id}} {{index .Config.Labels "nomo.typed.probe"}}',name])
        if inspect is not None and inspect.returncode==0:
            parts=inspect.stdout.split()
            if len(parts)==2 and parts[1]==name:
                removed=bounded(['docker','rm','-f',parts[0]])
                if removed is None or removed.returncode!=0:cleanup.append('owned container removal unconfirmed')
                else:record['owned_container_removed']=True
            else:cleanup.append('container ownership differs; preserved')
        elif inspect is not None and 'No such' in inspect.stderr:record['container_absent']=True
        else:cleanup.append('owned container absence unconfirmed')
        if forward is not None:
            try:
                if forward.poll() is None:
                    os.killpg(forward.pid,signal.SIGTERM)
                    try:forward.wait(timeout=available(1))
                    except subprocess.TimeoutExpired:os.killpg(forward.pid,signal.SIGKILL);forward.wait(timeout=available(1))
                record['owned_forward_exit']=forward.returncode;forward.stderr.close()
            except BaseException as error:cleanup.append(clean(repr(error)))
        while True:
            with lock:pending=[item for item in workers if not item['finished'].is_set()]
            if not pending:break
            for worker in pending:
                for connection in (worker['socket'],worker.get('upstream_socket')):
                    if connection is not None:
                        try:connection.shutdown(socket.SHUT_RDWR)
                        except OSError:pass
                        try:connection.close()
                        except OSError:pass
                upstream=worker.get('upstream')
                if upstream:
                    try:upstream.close()
                    except OSError:pass
            remaining=deadline-time.monotonic()
            if remaining<=0:break
            for worker in pending:worker['thread'].join(timeout=max(0,min(.05,deadline-time.monotonic())))
        with lock:registered=list(workers)
        for worker in registered:
            try:worker['thread'].join(timeout=max(0,deadline-time.monotonic()))
            except RuntimeError:cleanup.append('relay worker start/finish unconfirmed')
        with lock:
            stable=all(item['finished'].is_set() and not item['thread'].is_alive() for item in workers) and (thread is None or not thread.is_alive())
            record['handler_records_stable']=stable
            record['handler_threads']=len(workers)
            if not stable:cleanup.append('relay handlers did not finish; observed counters are lower bounds')
            if not 1<=len(record['requests'])<=9 or record['refused_requests'] or any(item.get('observer_error') for item in record['requests']) or record.get('handler_transport_errors'):
                record['status']='failed'
            record['total_elapsed_seconds']=time.monotonic()-start
            if record['total_elapsed_seconds']>180:cleanup.append('run-wide180second bound exceeded')
            if cleanup:record.update(status='failed',cleanup_errors=cleanup)
            record['exit']=client.returncode if client is not None else None
            observed_HTTP=sum(item.get('downstream_attempts',0) for item in record['requests'])
            record['observed_HTTP_attempts']=observed_HTTP if stable else None
            record['HTTP_attempts_observed_lower_bound']=observed_HTTP
            record['native_request_qualification']='Relay-observed count only after all handlers finish; native trace/report remain separate. No measured token-usage claim.'
            snapshot=copy.deepcopy(record)
        # Persist only a detached snapshot after bounded joins; live workers cannot mutate it.
        (folder/'runtime.stdout.bin').write_text(clean(out.decode(errors='replace')))
        (folder/'runtime.stderr.bin').write_text(clean(err.decode(errors='replace')))
        state=json.loads(ledger.read_text());state['A'].update(status=snapshot['status'],
            native_requests=len(snapshot['requests'])+snapshot['refused_requests'] if stable else None,
            HTTP_attempts=snapshot['observed_HTTP_attempts'],request_records_stable=stable,
            native_requests_observed_lower_bound=len(snapshot['requests'])+snapshot['refused_requests'],
            HTTP_attempts_observed_lower_bound=observed_HTTP)
        save(ledger,state);retain(snapshot)
    print('Probe1 '+snapshot['status']+'; relay requests='+str(len(snapshot['requests']))+'; HTTP='+str(snapshot['observed_HTTP_attempts']))
    return 0 if snapshot['status']=='qualified' else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--stage',choices=['prepare','controls','container-controls','run'],required=True)
    parser.add_argument('--evidence-dir',type=Path);parser.add_argument('--folder',type=Path);parser.add_argument('--private-env',type=Path);parser.add_argument('--ssh-host');parser.add_argument('--ledger',type=Path)
    options=parser.parse_args()
    if options.stage=='prepare':options.evidence_dir.mkdir(parents=True,exist_ok=True);prepare(options.evidence_dir);return 0
    assert options.folder and options.folder.is_absolute()
    if options.stage=='container-controls':container_controls(options.folder);return 0
    if options.stage=='controls':controls(options.folder);return 0
    assert options.private_env and options.ssh_host and options.ledger
    return execute(options.folder,options.private_env,options.ssh_host,options.ledger)


if __name__=='__main__':raise SystemExit(main())
