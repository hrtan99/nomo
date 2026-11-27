"""Existing production WorkModelStages preparation; synthetic HTTP, real read only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import json
import subprocess
import tempfile
import threading

from native_sources import copy_sources

ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = [
    ('typed', {'task': 'T'}),
    ('text', '["read","a.txt"]'),
    ('typed', {'text': 'Seen blue'}),
    ('text', 'Answer'),
    ('typed', {'task': 'edit T'}),
    ('typed', {'target': 'old', 'replacement': 'blue'}),
]


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        try:
            mode, output = OUTPUTS[index]
            data = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'user'))
            if index in (0, 3, 4, 5):
                assert data['previous_request'] == 'Earlier request' and data['previous']['answer'] == 'Earlier answer', data
                assert data['conversation'] == [], data
            if index == 0:
                assert data['current']['phase'] == 'plan' and data['current']['request'] == 'Q', data
            elif index == 2:
                assert 'blue' in json.dumps(data), data
            elif index == 3:
                assert data['current']['phase'] == 'aggregate' and data['current']['result'] == 'Seen blue', data
                assert data['current']['tool'] == 'read' and data['current']['outcome'] == 'complete: blue<LF>', data
            elif index in (4, 5):
                assert data['current']['edit']['before'] == 'old\n', data
                assert data['current']['evidence']['summary'] == 'Answer', data
            if mode == 'typed':
                emitted = next(item['function'] for item in request['tools'] if item['function']['name'] == 'etas_emit_output')
                assert set(emitted['parameters']['properties']) == set(output), emitted
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                    'id': f'call-{index}', 'type': 'function',
                    'function': {'name': 'etas_emit_output', 'arguments': json.dumps(output)}}]}
                finish = 'tool_calls'
            else:
                assert not request.get('tools'), request
                message, finish = {'role': 'assistant', 'content': output}, 'stop'
            body = json.dumps({'choices': [{'message': message, 'finish_reason': finish}],
                               'usage': {'prompt_tokens': 10, 'completion_tokens': 4, 'total_tokens': 14}}).encode()
        except BaseException as error:
            self.server.failures.append(repr(error))
            self.send_error(500, 'synthetic observer mismatch')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main(binary, graph):
    evidence = Path(tempfile.mkdtemp(prefix='nomo-harness-ports-0246-')).resolve()
    package, observed, reads = (evidence / name for name in ('package', 'observed', 'reads'))
    for folder in (package, observed, reads):
        folder.mkdir(mode=0o777)
        folder.chmod(0o777)
    (package / '.etas').mkdir()
    (reads / 'a.txt').write_text('blue\n')
    fixture = ROOT / 'tests/fixtures/harness_prepare_interface001/controller_probe.es'
    sources = copy_sources(ROOT, package, fixture)
    (package / 'src/app/main.es').rename(package / 'src/app/prepare_interface_probe.es')
    (evidence / 'sources.json').write_text(json.dumps(sources, indent=2) + '\n')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    server.requests, server.failures, server.evidence = [], [], evidence
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (package / 'etas.toml').write_text(f'''[package]
name = "harness-ports-0246"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.model]
adapter = "openai"
model = "synthetic-harness-stages"
base_url = "http://host.docker.internal:{server.server_port}/v1"
api_key_env = "NOMO_HARNESS_PROBE_TOKEN"
allow_private = true
[runtime.profiles.local.model.retry]
attempts = 1
delay_ms = 0
[runtime.profiles.local.filesystem.regions."nomo.tools.workspace.ReadOnlyRoot"]
root = "/fixture-read"
read = true
write = false
delete = false
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["console=allow", "model=allow", "filesystem:Fs.stat=allow", "filesystem:Fs.read=allow"]
[[bin]]
name = "harness-ports-0246"
module = "app.prepare_interface_probe"
flow = "production_stages"
''')
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {
        'environment': {'NOMO_HARNESS_PROBE_TOKEN': 'synthetic-local-only'},
        'volumes': [{'type': 'bind', 'source': str(package), 'target': '/workspace', 'read_only': True},
                    {'type': 'bind', 'source': str(observed), 'target': '/fixture-evidence'},
                    {'type': 'bind', 'source': str(reads), 'target': '/fixture-read', 'read_only': True}]}}}))
    command = ['docker', 'compose', '--project-name', 'nomo-harness-ports', '--env-file', '/dev/null']
    for path in ('compose.yaml', f'config/etas-{graph}-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / path)]
    inside = '''import json,pathlib,subprocess,time
t=time.monotonic();p=subprocess.run([__BINARY__,'--no-config','--cache','off','run','/workspace','--flow','production_stages','--allow-effects','--trace-out','/fixture-evidence/production.trace.json'],capture_output=True,text=True)
r={'exit':p.returncode,'elapsed_seconds':time.monotonic()-t,'stdout':p.stdout,'stderr':p.stderr,'resources':{k:(pathlib.Path('/sys/fs/cgroup')/k).read_text().strip() for k in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}}
pathlib.Path('/fixture-evidence/result.json').write_text(json.dumps(r,indent=2)+'\\n');print(json.dumps(r))'''.replace('__BINARY__', repr(binary))
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev', 'python3', '-c', inside]
    (evidence / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        (evidence / 'docker.log').write_text(run.stdout + run.stderr)
        result = json.loads(run.stdout)
        result.update(model_requests=len(server.requests), observer_failures=server.failures)
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        assert run.returncode == 0 and result['exit'] == 0 and not result['stderr'], result
        assert len(server.requests) == 6 and not server.failures, result
        assert 'PASS production historical stages' in result['stdout'], result
        assert (reads / 'a.txt').read_text() == 'blue\n'
        trace = json.loads((observed / 'production.trace.json').read_text())
        starts = {item['id']: item for item in trace['events'] if item['kind'] == 'host_request_started'}
        ends = {item['id']: item for item in trace['events'] if item['kind'] == 'host_request_finished'}
        assert trace['outcome']['kind'] == 'completed' and trace['termination']['local_work_settled']
        assert set(starts) == set(ends) and all(item['outcome']['kind'] == 'succeeded' for item in ends.values())
        actions = {}
        for item in starts.values():
            name = item['qualified_action']
            actions[name] = actions.get(name, 0) + 1
        assert actions.get('Agentic.infer') == 6 and actions.get('Fs.read') == 1, actions
        assert set(actions) <= {'Agentic.infer', 'Fs.read', 'Fs.stat', 'Console.stdout_write', 'Policy.evaluate'}, actions
        result.update(status='passed', paired_requests=len(starts), host_actions=actions,
                      qualification='Real HistoryStages/child loop with six synthetic-local responses and one read. Original acquisition is controlled; no edit, approval, Memory, command, persistence or completed-work claim.')
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print('PASS existing production WorkModelStages prepare, six synthetic model calls and one actual read')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default='/home/nomo/.cargo/bin/etas')
    parser.add_argument('--graph', default='0247', help='official graph label, e.g. 0247')
    args = parser.parse_args()
    main(args.binary, args.graph)
