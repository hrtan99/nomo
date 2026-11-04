#!/usr/bin/env python3
"""Send synthetic >1 MiB context through the ETAS main model to a local fake."""
import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = Path(tempfile.mkdtemp(prefix='nomo-large-input-', dir='/private/tmp'))
project = out / 'project'
shutil.copytree(root, project, ignore=shutil.ignore_patterns('.git', '.etas', 'tmp', '__pycache__'))
(project / '.etas').mkdir()
(project / 'src/app').mkdir()
shutil.copyfile(root / 'tests/fixtures/chat_budget/large_input.es', project / 'src/app/large_input.es')
entry = project / 'src/nomo/main.es'
entry.write_text(entry.read_text().replace('module nomo.main;', 'module nomo.main;\nimport app.large_input.probe as large_input_probe;') +
                 '\npublic flow probe(args: Array<string>) -> i32 { return large_input_probe(args); }\n')
workspace = out / 'workspace'
workspace.mkdir(mode=0o755)
(workspace / 'note.txt').write_text('synthetic')


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            index = len(self.server.seen)
            payload = request['messages'][1]['content']
            if index in (0, 2):
                context = json.loads(payload)
                assert len(payload.encode()) > 1048576
                assert len(context['history']) == 6
                assert all(len(event['text']) == 262144 for event in context['history'][1:])
                assert request['max_tokens'] == 131072
            else:
                assert index == 1 and request['max_tokens'] == 4096
            response = (['delegate', 'Read the task'] if index == 0 else
                        ['final', 'Synthetic evidence'] if index == 1 else 'Synthetic answer')
            content = json.dumps(response, separators=(',', ':')) if isinstance(response, list) else response
            data = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}],
                               'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}).encode()
            self.server.seen.append({'index': index, 'payload_bytes': len(payload.encode()), 'max_tokens': request['max_tokens']})
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            self.server.error = repr(error)
            self.send_error(500)


server = HTTPServer(('127.0.0.1', 0), Fake)
server.seen = []
server.error = None
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    manifest = project / 'etas.toml'
    value = manifest.read_text()
    value = value.replace('[runtime.profiles.nomo-read-events-new.memory]\nbackend = "sqlite"\npath = "history.sqlite3"',
                          '[runtime.profiles.nomo-read-events-new.memory]\nbackend = "sqlite"\npath = "/tmp/history.sqlite3"')
    start = value.index('[runtime.profiles.nomo-read-events-new.model]')
    end = value.index('[runtime.profiles.nomo-read-events-new.model.timeout]', start)
    model = value[start:end].replace('https://api.minimax.cn/v1', 'http://host.docker.internal:%d/v1' % server.server_port)
    value = value[:start] + model.replace('allow_private = false', 'allow_private = true') + value[end:]
    value = value.replace('[runtime.profiles.nomo-read-events-new.filesystem.regions."nomo.session.event_policy.PolicyRoot"]\nroot = "/tmp/nomo-event-policy"\nread = true\nwrite = false\n', '')
    manifest.write_text(value)
    override = out / 'compose.yaml'
    override.write_text('''services:
  dev:
    network_mode: bridge
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      MINIMAX_API_KEY: SYNTHETIC_ONLY
    volumes:
      - type: bind
        source: %s
        target: /model-tool-fixture
        read_only: true
''' % json.dumps(str(workspace)))
    docker = '/Applications/Docker.app/Contents/Resources/bin/docker'
    command = [docker, 'compose', '--env-file', '/dev/null', '-f', str(project / 'compose.yaml'),
               '-f', str(project / 'config/etas-026-official-compose.yaml'),
               '-f', str(project / 'config/etas-runtime-cache-compose.yaml'), '-f', str(override),
               'run', '--rm', '--no-deps', '-T', 'dev', 'python3', '-B', '/workspace/scripts/nomo-verified-etas.py',
               'run', '/workspace', '--flow', 'probe', '--profile', 'nomo-read-events-new', '--allow-effects']
    env = dict(os.environ, NOMO_ETAS_GRAPH='026-v68')
    result = subprocess.run(command, cwd=project, env=env, capture_output=True, text=True, timeout=300)
    (out / 'result.log').write_text(result.stdout + result.stderr)
    if result.returncode or server.error or len(server.seen) != 3 or 'PASS large input' not in result.stdout:
        raise RuntimeError({'exit': result.returncode, 'error': server.error, 'calls': server.seen,
                            'tail': (result.stdout + result.stderr)[-4000:]})
    print(json.dumps({'status': 'passed', 'calls': server.seen, 'result_dir': str(out),
                      'scope': 'synthetic encoded bytes; no provider tokenizer or real model usage'}))
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
