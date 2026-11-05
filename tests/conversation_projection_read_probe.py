#!/usr/bin/env python3
"""Verify latest large evidence is referenced, not duplicated, in a resumed read request."""
import json, os, re, shutil, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ''.join(f'line {index:05d}: projection evidence\n' for index in range(5000))
REFERENCE = 'Exact latest tool outcome supplied separately as current.prior.outcome for read stages or previous.outcome for work stages; duplicate text omitted.'


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_POST(self):
        try:
            raw = self.rfile.read(int(self.headers['Content-Length']))
            request = json.loads(raw)
            context = json.loads(next(message['content'] for message in reversed(request['messages']) if message['role'] == 'user'))
            current = context.get('current', context)
            phase = len(self.server.phases)
            if phase == 0:
                assert current['request'] == 'Read the large note.' and current['allowed'] == ['note.txt']
                value = ['delegate', 'Read note.txt']
            elif phase in (1, 5): value = ['read', 'note.txt']
            elif phase in (2, 6):
                encoded = json.dumps(context, ensure_ascii=False)
                assert 'line 00000: projection evidence' in encoded and 'line 04999: projection evidence' in encoded
                value = ['final', 'The large note was read']
            elif phase in (3, 7):
                if phase == 7:
                    assert context['current']['request'] == 'Read it again.'
                    prior = context['current']['prior']['outcome']
                    history = json.dumps(context['history'], ensure_ascii=False)
                    assert 'line 00000: projection evidence' in prior and 'line 04999: projection evidence' in prior
                    assert REFERENCE in history and 'line 00000: projection evidence' not in history and 'line 04999: projection evidence' not in history
                    self.server.metrics = {'request_bytes': len(raw), 'prior_bytes': len(prior.encode()), 'history_bytes': len(history.encode())}
                    assert self.server.metrics['prior_bytes'] > 100000 and self.server.metrics['history_bytes'] < 4096
                value = 'second read complete' if phase == 7 else 'first read complete'
            elif phase == 4:
                prior = context['current']['prior']['outcome']
                history = json.dumps(context['history'], ensure_ascii=False)
                assert 'line 00000: projection evidence' in prior and 'line 04999: projection evidence' in prior
                assert REFERENCE in history and 'line 00000: projection evidence' not in history and 'line 04999: projection evidence' not in history
                value = ['delegate', 'Read note.txt again']
            else: raise AssertionError('unexpected request phase')
            if request.get('tools'):
                output = {'text': value[1]}
                message = {'role':'assistant','content':None,'tool_calls':[{'id':'synthetic-output','type':'function','function':{'name':'etas_emit_output','arguments':json.dumps(output,separators=(',',':'))}}]}
                finish_reason = 'tool_calls'
            else:
                content = json.dumps(value, separators=(',', ':')) if isinstance(value, list) else value
                message = {'role':'assistant','content':content}; finish_reason = 'stop'
            body = json.dumps({'choices':[{'message':message,'finish_reason':finish_reason}], 'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
            self.server.phases.append(phase); self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as error:
            self.server.failure = repr(error); self.send_error(500)


def main():
    output = Path(tempfile.mkdtemp(prefix='nomo-projection-read-')); project = output/'project'
    shutil.copytree(ROOT, project, ignore=shutil.ignore_patterns('.git','.etas','tmp','docs','__pycache__','.pytest_cache','user_context_chain_v4*.es','user_context_v4*'))
    (project/'.etas').mkdir(mode=0o700)
    workspace = output/'workspace'; workspace.mkdir(mode=0o700); (workspace/'note.txt').write_text(CONTENT)
    server = HTTPServer(('127.0.0.1', 0), Fake); server.phases=[]; server.failure=None; server.metrics=None
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    try:
        manifest = project/'etas.toml'; text = manifest.read_text()
        for profile in ('nomo-read-events-new','nomo-read-events-existing'):
            start=text.index('[runtime.profiles.'+profile+'.model]'); end=text.index('[runtime.profiles.'+profile+'.model.timeout]',start)
            part=text[start:end].replace('https://api.minimax.cn/v1',f'http://host.docker.internal:{server.server_port}/v1').replace('allow_private = false','allow_private = true')
            text=text[:start]+part+text[end:]
        manifest.write_text(text)
        state=output/'state'; env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'MINIMAX_API_KEY':'SYNTHETIC_ONLY','NOMO_ETAS_VERSION':'0.4.1','NOMO_STATE_DIR':str(state)}
        first=subprocess.run([str(project/'scripts/nomo'),'--root',str(workspace),'--allow','note.txt','--high-input','--once','Read the large note.'],env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=180)
        identifiers=re.findall(rb'SESSION ID ([0-9a-f]{32})',first.stdout)
        assert first.returncode == 0 and len(identifiers) == 1, (first.returncode, server.failure, first.stdout[-2000:], first.stderr[-1000:])
        second=subprocess.run([str(project/'scripts/nomo'),'--id',identifiers[0].decode(),'--root',str(workspace),'--allow','note.txt','--once','Read it again.'],env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=180)
        assert second.returncode == 0 and server.failure is None and server.phases == list(range(8)), (second.returncode, server.failure, server.phases, second.stdout[-2000:], second.stderr[-1000:])
        print(json.dumps({'status':'passed','scope':'two-turn same-ID read with local fake model','fake_requests':len(server.phases),**server.metrics}))
    finally:
        server.shutdown(); server.server_close(); worker.join(timeout=5); shutil.rmtree(output)


if __name__ == '__main__': main()
