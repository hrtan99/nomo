#!/usr/bin/env python3
"""Exercise opt-in four-turn chat with an owned local synthetic provider."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from read_container_identity import inspect_launch, container_absent

ROOT = Path(__file__).resolve().parent.parent
TOKEN = 'NOMO_FOUR_CHAT_SYNTHETIC_ONLY'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint():
    h = hashlib.sha256()
    for p in sorted((ROOT/'src').rglob('*.es')):
        h.update(str(p.relative_to(ROOT)).encode()+b'\0'+bytes.fromhex(sha(p)))
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--scenario', choices=('four','mixed','exhaust','failure','interrupt','default'), required=True)
    args = parser.parse_args(); args.evidence_dir.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='chat-four-'+args.scenario+'-', dir=args.evidence_dir))
    root = out/'read'; (root/'docs').mkdir(parents=True)
    file = root/'docs/a.txt'; file.write_text('synthetic blue\n')
    counts = {'started':0,'completed':0,'turn':0,'valid':True,'max_tokens':[]}
    identity = {}; gate = threading.Event(); release = threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            try:
                counts['started'] += 1
                if counts['started'] == 1: identity.update(inspect_launch(ROOT, root, '0.2.3'))
                assert self.path == '/v1/chat/completions' and self.headers.get('Authorization') == 'Bearer '+TOKEN
                length = int(self.headers['Content-Length']); assert 0 < length <= 196608
                body = json.loads(self.rfile.read(length)); context = json.loads(body['messages'][1]['content'])
                assert body['max_tokens'] == 2048
                counts['max_tokens'].append(body['max_tokens'])
                if context.get('phase') == 'plan':
                    counts['turn'] += 1; turn = counts['turn']
                    assert context['request'] == 'question-'+str(turn)
                    assert context['allowed'] == ['docs/a.txt']
                    previous = context['prior']
                    if turn == 1: assert all(previous[k] == '' for k in ('task','result','tool','outcome','answer'))
                    else:
                        assert previous['task'] == 'delegated-'+str(turn-1)
                        assert previous['result'] == 'child-'+str(turn-1) and previous['answer'] == 'answer-'+str(turn-1)
                        previous_direct = args.scenario == 'mixed' and turn-1 in (2,4)
                        assert previous['tool'] == ('' if previous_direct else 'read')
                        assert previous['outcome'] == ('' if previous_direct else 'complete: synthetic blue<LF>')
                    if args.scenario == 'interrupt' and turn == 2:
                        gate.set(); assert release.wait(45)
                    text = '["invalid"]' if args.scenario == 'failure' and turn == 2 else json.dumps(['delegate','delegated-'+str(turn)])
                elif context.get('phase') == 'aggregate':
                    turn = counts['turn']; assert context['result'] == 'child-'+str(turn)
                    text = 'answer-'+str(turn)
                else:
                    turn = counts['turn']; assert context['allowed'] == ['docs/a.txt']
                    if turn > 1:
                        prior_events = {x['name']:x['text'] for x in context['history'] if x['kind'] == 'context'}
                        assert prior_events['task'] == 'delegated-'+str(turn-1)
                        assert prior_events['result'] == 'child-'+str(turn-1) and prior_events['answer'] == 'answer-'+str(turn-1)
                    direct = args.scenario == 'mixed' and turn in (2,4)
                    if not context['final_only'] and not direct:
                        text = json.dumps(['read','docs/a.txt'])
                    else:
                        if context['final_only']: assert 'synthetic blue' in context['history'][-1]['text']
                        text = json.dumps(['final','child-'+str(turn)])
                reply = json.dumps({'choices':[{'message':{'role':'assistant','content':text},'finish_reason':'stop'}],
                                    'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}).encode()
                self.send_response(200);self.send_header('Content-Length',str(len(reply)));self.end_headers();self.wfile.write(reply)
                counts['completed'] += 1
            except (BrokenPipeError, ConnectionResetError):
                if args.scenario != 'interrupt': counts['valid'] = False
            except Exception:
                counts['valid'] = False
                try:self.send_error(500)
                except Exception:pass
    server = HTTPServer(('127.0.0.1',0),Handler)
    server_thread = threading.Thread(target=server.serve_forever,daemon=True); server_thread.start()
    proc = None; result={'status':'failed','scope':'non-TTY actual launcher; synthetic data and local fake model only','scenario':args.scenario}
    before = fingerprint()
    inputs = {str(p.relative_to(ROOT)):sha(p) for p in [ROOT/'scripts/nomo-read.sh',ROOT/'scripts/nomo-verified-etas.py',ROOT/'tests/read_container_identity.py',Path(__file__).resolve(),ROOT/'config/etas-023-official.Cargo.lock']}
    try:
        env = dict(os.environ,NOMO_ETAS_VERSION='0.2.3',NOMO_READ_MODEL_BASE_URL='http://host.docker.internal:%d/v1'%server.server_port,
                   NOMO_READ_MODEL_NAME='synthetic',NOMO_QWEN_SERVER_API_KEY=TOKEN)
        cmd=[str(ROOT/'scripts/nomo-read.sh'),'chat','--root',str(root),'--allow','docs/a.txt']
        if args.scenario != 'default':cmd += ['--turns','4']
        tasks = 3 if args.scenario == 'default' else 5 if args.scenario == 'exhaust' else 4
        inputs_text = ''.join('question-%d\n'%i for i in range(1,tasks+1))+'/exit\n'
        proc = subprocess.Popen(cmd,cwd=ROOT,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        if args.scenario == 'interrupt':
            proc.stdin.write(inputs_text.encode());proc.stdin.flush();proc.stdin.close();proc.stdin=None
            assert gate.wait(80), 'second turn request not observed'
            os.killpg(proc.pid,signal.SIGTERM)
            stdout,stderr=proc.communicate(timeout=35)
            release.set()
        else:
            stdout,stderr=proc.communicate(inputs_text.encode(),timeout=180)
        (out/'stdout.bin').write_bytes(stdout);(out/'stderr.bin').write_bytes(stderr)
        finals = [x.decode() for x in stdout.splitlines() if x.startswith(b'FINAL ')]
        assert counts['valid'] and file.read_text() == 'synthetic blue\n' and fingerprint()==before
        assert identity and container_absent(identity['container_id'])
        if args.scenario in ('four','mixed'):
            expected_calls=16 if args.scenario=='four' else 14
            assert proc.returncode==0 and len(finals)==4 and counts['started']==counts['completed']==expected_calls
            assert b'STOP exit turns=4' in stdout
        elif args.scenario == 'exhaust':
            assert proc.returncode!=0 and len(finals)==4 and counts['started']==counts['completed']==16
            assert b'REFUSED turn limit reached' in stdout and b'STOP turn limit turns=4' in stdout
            assert b'LEDGER steps=28/28 calls=16/16 tokens=32768/32768 tools=4/4 scan=16384/16384' in stdout
        elif args.scenario == 'failure':
            assert proc.returncode!=0 and len(finals)==1 and counts['started']==counts['completed']==5
            assert b'STOP turn failed turns=2' in stdout and b'calls=5/16 tokens=10240/32768' in stdout
        elif args.scenario == 'default':
            assert proc.returncode!=0 and len(finals)==2 and counts['started']==counts['completed']==8
            assert b'STOP turn limit turns=2' in stdout and b'calls=8/8 tokens=16384/16384' in stdout
        else:
            assert proc.returncode in (125,143) and len(finals)==1 and counts['started']==5
            assert b'TURN 2 STAGE plan' in stdout and b'reserved_calls=3' in stdout
        assert all(finals[i]=='FINAL answer-'+str(i+1) for i in range(len(finals)))
        assert b'Only the immediately preceding turn is retained' in stdout
        result.update(status='passed',exit=proc.returncode,counts=counts.copy(),finals=finals,source_sha256=before,
                      inputs=inputs,container_identity=identity,container_absent=True,file_unchanged=True)
    except BaseException as e:
        result.update(failure_type=type(e).__name__,failure=str(e),counts=counts.copy())
    finally:
        release.set()
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid,signal.SIGTERM)
            try:proc.communicate(timeout=20)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.communicate(timeout=3)
        server.shutdown();server.server_close();server_thread.join(timeout=5)
        result.update(server_stopped=not server_thread.is_alive(),launcher_stopped=proc is None or proc.poll() is not None)
        (out/'result.json').write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    print(json.dumps({'status':result['status'],'evidence':str(out)}))
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
