"""Native model -> approved exact argv/stdin -> actual result -> native history."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import tempfile
import threading

from native_recovery_probe import terminal, audit

ROOT = Path(__file__).resolve().parents[1]
INPUT = 'pelican café\nline two\n'
ARGUMENTS = ['-c', "import sys; print('stdin=' + sys.stdin.read(), end='')"]


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        if index == 0:
            name, arguments = 'run_command_input', {'program': '/usr/bin/python3', 'arguments': ARGUMENTS, 'input': INPUT}
        else:
            assert index == 1
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            assert result == {'exit_code': 0, 'stdout': 'stdin=' + INPUT, 'stderr': ''}, result
            name, arguments = 'etas_emit_output', {'text': 'Native foreground stdin and actual command result completed.'}
        assert any(item['function']['name'] == name for item in request['tools'])
        body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': None,
            'tool_calls': [{'id': f'call-{index}', 'type': 'function',
                            'function': {'name': name, 'arguments': json.dumps(arguments)}}]},
            'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def approve_input(output):
    preview = next(line.split('[COMMAND] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line)
    assert json.loads(preview) == {'program': '/usr/bin/python3', 'arguments': ARGUMENTS, 'stdin': INPUT}


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-stdin-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.evidence = [], evidence
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1', NOMO_MODEL_ALLOW_PRIVATE='true',
        NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0134-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
        '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
        '--allow-effects', '--trace-out', '/native-evidence/trace.json', '--args', '--workspace', str(project)]
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        code, output, approvals, _ = terminal(command, environment,
            ['Run one foreground command with the provided complete UTF-8 input.', '/history', '/status', '/runs', '/quit'],
            project, approve=approve_input)
        (evidence / 'terminal.txt').write_text(output)
        assert code == 0 and approvals == 1 and len(server.requests) == 2, output
        history = [json.loads(line.split('[tool_call/command #1] ', 1)[1]) for line in output.splitlines() if '[tool_call/command #1] ' in line]
        assert history == [{'program': '/usr/bin/python3', 'arguments': ARGUMENTS, 'stdin': INPUT}]
        status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in output.splitlines() if '[STATUS ] ' in line))
        assert status['pending'] == '' and status['ledger']['tools'] == 1
        runs = [json.loads(line.split('[RUN    ] ', 1)[1]) for line in output.splitlines() if '[RUN    ] {' in line]
        assert len(runs) == 2 and all(item['phase'] == 'completed' for item in runs), runs
        trace = json.loads((traces / 'trace.json').read_text())
        assert trace['outcome']['kind'] == 'completed'
        failures = audit(trace['events'])
        (evidence / 'functional.json').write_text(json.dumps({'functional_status': 'passed', 'model_http_requests': 2,
            'native_command_dispatches': 1, 'native_approvals': approvals, 'input': INPUT, 'status': status,
            'runs': runs, 'approval_audit': failures}, indent=2))
        print('FUNCTIONAL PASS native exact stdin, model continuation and durable history: ' + str(evidence), flush=True)
        assert not failures, 'upstream Command approval provenance audit failed (#102); see functional.json'
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
