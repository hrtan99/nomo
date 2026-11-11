"""Native background process I/O, stop, approved actions and saved output restore."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import tempfile
import threading

from native_recovery_probe import terminal, audit

ROOT = Path(__file__).resolve().parents[1]
ECHO = ['-u', '-c', "import sys; print('ready', flush=True)\nfor line in sys.stdin: print('echo:' + line.rstrip('\\n'), flush=True)"]
SLEEP = ['-u', '-c', "import time; print('sleeping', flush=True); time.sleep(30)"]
INPUT = '鹈鹕 café\n'


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        result = None
        if 0 < index <= 9:
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
        if index in (1, 7):
            assert result['phase'] == 'started' and result['handle'], result
            self.server.jobs.append(result)
        if index == 2:
            assert result['stdout'] == 'ready\n' and bytes(result['stdout_bytes']) == b'ready\n', result
        if index in (3, 5):
            assert result['status'] == 'completed', result
        if index == 4:
            assert result['stdout'] == 'echo:' + INPUT and bytes(result['stdout_bytes']) == ('echo:' + INPUT).encode(), result
        if index == 6:
            assert result['phase'] == 'exited' and result['exit_code'] == {'name': 'Some', 'fields': [0]}, result
        if index == 8:
            assert result['phase'] == 'stopped', result
        if index == 9:
            assert len(result) == 3 and [item['phase'] for item in result] == ['output', 'output', 'exited'], result
            assert b''.join(bytes(item['stdout_bytes']) for item in result) == ('ready\necho:' + INPUT).encode(), result
        first = self.server.jobs[0]['id'] if self.server.jobs else ''
        if index == 0:
            name, arguments = 'start_job', {'program': '/usr/bin/python3', 'arguments': ECHO}
        elif index in (1, 3, 5):
            name, arguments = 'read_job', {'job': first, 'max_bytes': 4096}
        elif index == 2:
            name, arguments = 'write_job', {'job': first, 'input': INPUT}
        elif index == 4:
            name, arguments = 'close_job_input', {'job': first}
        elif index == 6:
            name, arguments = 'start_job', {'program': '/usr/bin/python3', 'arguments': SLEEP}
        elif index == 7:
            name, arguments = 'stop_job', {'job': self.server.jobs[1]['id']}
        elif index == 8:
            name, arguments = 'job_output', {'job': first}
        else:
            assert index < 12, index
            name, arguments = 'etas_emit_output', {'text': 'Native background input/output, EOF, stop and saved output completed.'}
            if index >= 10:
                data = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'user'))
                assert {item['phase'] for item in data['jobs']} == {'exited', 'stopped'}, data
                assert data['pending'] == '' and any('echo:' in item['text'] for item in data['history']), data
        assert any(item['function']['name'] == name for item in request['tools'])
        body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': None,
            'tool_calls': [{'id': f'call-{index}', 'type': 'function',
                            'function': {'name': name, 'arguments': json.dumps(arguments)}}]},
            'finish_reason': 'tool_calls'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-process-')).resolve()
    project = evidence / 'project'
    project.mkdir(mode=0o700)
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.jobs, server.evidence = [], [], evidence
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only', NOMO_NATIVE_STATE=str(evidence / 'state'),
        NOMO_NATIVE_TRACE_ROOT=str(evidence / 'traces'), NOMO_MODEL_ALLOW_PRIVATE='true',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1')
    command = [str(ROOT / 'scripts/nomo-native'), str(project)]
    def approve(output):
        value = json.loads(next(line.split('[PROCESS] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[PROCESS] ' in line))
        if value['operation'] == 'start':
            assert value == {'operation': 'start', 'program': '/usr/bin/python3', 'arguments': ECHO if not server.jobs else SLEEP}, value
        else:
            assert any(value['job'] == item['id'] and value['handle'] == item['handle'] for item in server.jobs), value
            assert value['operation'] in ('reconnect', 'read', 'write', 'close_stdin', 'stop'), value
            if value['operation'] == 'write': assert value['input'] == INPUT, value
            if value['operation'] == 'read': assert value['max_bytes'] == 4096, value
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        code, output, approvals, _ = terminal(command + ['--new'], env,
            ['Exercise the native background echo process, exact input, EOF, stopping a sleeper and retained output.',
             'What did the processes actually do?', '/jobs', '/status', '/runs', '/quit'], project, approve=approve)
        (evidence / 'terminal.txt').write_text(output)
        assert code == 0 and approvals == 14 and len(server.requests) == 11, output
        first = server.jobs[0]['id']
        code, restored, restored_approvals, _ = terminal(command + ['--resume', 'native-0'], env,
            ['/jobs', '/job-output ' + first, 'Describe the saved process observations.', '/status', '/runs', '/quit'], project, approve=approve)
        (evidence / 'restored-terminal.txt').write_text(restored)
        assert code == 0 and restored_approvals == 0 and len(server.requests) == 12, restored
        archived = [json.loads(line.split('[JOB    ] ', 1)[1]) for line in restored.splitlines() if '[JOB    ] [' in line]
        assert len(archived) == 1 and len(archived[0]) == 3, archived
        traces = [Path(next(line.split('[TRACE  ] ', 1)[1] for line in text.splitlines() if '[TRACE  ] ' in line)) / 'trace.json' for text in (output, restored)]
        actions, failures = [], []
        for path in traces:
            trace = json.loads(path.read_text())
            assert trace['outcome']['kind'] == 'completed', trace['outcome']
            failures += audit(trace['events'])
            actions += [item['qualified_action'] for item in trace['events'] if item['kind'] == 'host_request_started' and item.get('qualified_action', '').startswith('Command.')]
        assert actions == ['Command.start', 'Command.reconnect', 'Command.read', 'Command.reconnect', 'Command.write',
            'Command.reconnect', 'Command.read', 'Command.reconnect', 'Command.write', 'Command.reconnect', 'Command.read',
            'Command.start', 'Command.reconnect', 'Command.stop'], actions
        assert not failures, failures
        result = {'functional_status': 'passed', 'approval_status': 'passed', 'model_http_requests': 12,
            'native_approvals': approvals, 'native_actions': actions, 'restored_commands': 0, 'jobs': server.jobs,
            'saved_output_events': archived[0], 'traces': [str(path) for path in traces], 'approval_audit': failures,
            'limitation': 'Live process operations accepted within one Etas Host; the restart checks saved metadata/output, not a live process reattachment.'}
        (evidence / 'functional.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print('PASS native background process I/O, EOF, stop, strict approvals and saved output restore: ' + str(evidence), flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
