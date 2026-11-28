"""Old persisted ArchivedJob identity and the original three-call text route."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import importlib.util
import json
import shutil
import subprocess
import tempfile
import threading

from native_sources import copy_sources

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/file_consolidation'


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        context = json.loads(request['messages'][1]['content'])
        self.server.contexts.append(context)
        phase = context['phase']
        assert context['request'] == 'alpha'
        text = {'plan': '["delegate","work:alpha"]',
                'child': 'child:work:alpha|alpha',
                'aggregate': 'answer:child:work:alpha|alpha'}[phase]
        body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': text},
                                       'finish_reason': 'stop'}],
                           'usage': {'prompt_tokens': 10, 'completion_tokens': 4, 'total_tokens': 14}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def manifest(package, model_url):
    (package / '.etas').mkdir()
    (package / 'etas.toml').write_text(f'''[package]
name = "file-consolidation"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.memory]
backend = "sqlite"
path = "/consolidation/jobs.sqlite3"
[runtime.profiles.local.model]
adapter = "omlx-openai"
model = "synthetic-local-only"
base_url = "{model_url}"
api_key_env = "NOMO_CONSOLIDATION_TEST_KEY"
allow_private = true
enable_thinking = false
[runtime.profiles.local.model.retry]
attempts = 1
delay_ms = 0
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["memory=allow", "console=allow", "agentic=allow", "model=allow"]
[runtime.profiles.local.approval]
mode = "deny"
[[bin]]
name = "file-consolidation"
module = "app.main"
flow = "main"
''')


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-file-consolidation-')).resolve()
    evidence.chmod(0o777)
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.contexts = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://host.docker.internal:{server.server_port}/v1'
    old, current, text = (evidence / name for name in ('old', 'current', 'text'))
    shutil.copytree(FIXTURES / 'old', old / 'src')
    sources = copy_sources(ROOT, current, FIXTURES / 'read.es')
    sources.update(copy_sources(ROOT, text, FIXTURES / 'text.es'))
    for package in (old, current, text):
        manifest(package, url)
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {
        'network_mode': 'bridge',
        'extra_hosts': ['host.docker.internal:host-gateway'],
        'environment': {'NOMO_CONSOLIDATION_TEST_KEY': 'synthetic-local-only'},
        'volumes': [{'type': 'bind', 'source': str(evidence), 'target': '/consolidation'}]}}}))
    command = ['docker', 'compose', '--project-name', 'nomo-file-consolidation', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-02413-official-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    inside = '''import json,pathlib,subprocess,sqlite3
out=pathlib.Path('/consolidation');results={}
for name in ['old','current','text']:
 if name=='current':
  with sqlite3.connect(out/'jobs.sqlite3') as db:before=db.execute('select region,path,key_json,value_json from memory_entries order by region,path,key_json').fetchall()
 p=subprocess.run(['/home/nomo/.cargo/bin/etas','--no-config','--quiet','--cache','off','run',str(out/name),'--allow-effects','--trace-out',str(out/(name+'.trace.json'))],capture_output=True,text=True)
 results[name]={'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
 if p.returncode:break
 if name=='current':
  with sqlite3.connect(out/'jobs.sqlite3') as db:after=db.execute('select region,path,key_json,value_json from memory_entries order by region,path,key_json').fetchall()
  results['persisted_rows_unchanged']=before==after
(out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
'''
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev', 'python3', '-c', inside]
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=300)
        (evidence / 'container.stderr').write_text(result.stderr)
        assert result.returncode == 0, result.stderr
        observed = json.loads((evidence / 'results.json').read_text())
        for name in ('old', 'current', 'text'):
            assert observed[name]['exit'] == 0 and not observed[name]['stderr'], observed
        assert observed['persisted_rows_unchanged'] is True
        assert observed['current']['stdout'] == 'PASS prior ArchivedJob and exact raw output\n'
        spec = importlib.util.spec_from_file_location('original_text_route', ROOT / 'tests/fixtures/harness_model001/cases.py')
        cases = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cases)
        assert observed['text']['stdout'] == cases.expected_stdout(cases.cases()[0]), observed['text']
        assert server.contexts == [cases.context(), cases.context('child', task='work:alpha'),
                                   cases.context('aggregate', task='work:alpha', result='child:work:alpha|alpha')]
        record = {'status': 'passed', 'evidence': str(evidence), 'model_http_calls': len(server.contexts),
                  'exact_original_text_output': True, 'charged_steps': 5, 'charged_calls': 3,
                  'generation_allowance': 6144, 'old_archived_job_read': True,
                  'stored_rows_unchanged': True, 'sources': sources}
        (evidence / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
        print('PASS old stored nominal and original charged text route: ' + str(evidence))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
