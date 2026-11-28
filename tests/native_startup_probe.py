"""Native startup requests, resident inspection and a scoped check override."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import subprocess
import tempfile
import threading

from native_recovery_probe import audit, terminal
from native_worker_probe import Client, execution_pid

ROOT = Path(__file__).resolve().parents[1]
CHECK = ["/usr/bin/python3", "-c", "import sys; from pathlib import Path; assert sys.argv[1] == '--status'; Path('check.txt').write_text('startup check'); print('override passed')", "--status"]


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        turn = json.loads(next(item['content'] for item in request['messages'] if item['role'] == 'user'))
        assert turn['settings']['check'] == CHECK, turn['settings']
        assert turn['request'] == '--root', turn
        if index == 0:
            name, arguments = 'check_project', {}
        else:
            assert index == 1
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            assert result['configured'] and result['output'][0]['exit_code'] == 0, result
            assert result['output'][0]['stdout'] == 'override passed\n', result
            name, arguments = 'etas_emit_output', {'text': 'Startup check override completed.'}
        assert any(item['function']['name'] == name for item in request['tools'])
        body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': None,
            'tool_calls': [{'id': f'startup-{index}', 'type': 'function',
                            'function': {'name': name, 'arguments': json.dumps(arguments)}}]},
            'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def status(text):
    return json.loads(next(line.split('[STATUS ] ', 1)[1] for line in text.splitlines() if '[STATUS ] {' in line))


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-startup-')).resolve()
    project, other = evidence / 'project', evidence / 'other'
    project.mkdir(mode=0o700); other.mkdir(mode=0o700)
    packet = {'format': 'nomo-native-conversation-1',
              'session': {'id': 'source', 'workspace': 'synthetic', 'title': 'Imported', 'metadata': '{}'},
              'events': [{'id': '0', 'role': 'user', 'name': '', 'text': 'Keep the startup objective.'},
                         {'id': '1', 'role': 'assistant', 'name': '', 'text': 'Earlier 鹈鹕 context.'}]}
    (project / 'history.json').write_text(json.dumps(packet, ensure_ascii=False))
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-unused', NOMO_NATIVE_STATE=str(evidence / 'state'),
                       NOMO_NATIVE_TRACE_ROOT=str(evidence / 'traces'))
    command = [str(ROOT / 'scripts/nomo-native'), '--root', str(project)]
    print('EVIDENCE ' + str(evidence), flush=True)

    def run(name, args, input=''):
        result = subprocess.run(args, cwd=ROOT, env=environment, input=input, capture_output=True, text=True)
        (evidence / (name + '-stdout.txt')).write_text(result.stdout)
        (evidence / (name + '-stderr.txt')).write_text(result.stderr)
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout

    imported = status(run('import', command + ['--import', 'history.json', '--title', 'Startup α', '--status']))
    assert imported['title'] == 'Startup α' and imported['next_event'] == 3, imported
    second = status(run('other', [str(ROOT / 'scripts/nomo-native'), str(other), '--new', '--title', 'Other project', '--status']))
    listing = run('sessions', command + ['--sessions', '--all'])
    assert imported['id'] in listing and second['id'] in listing and str(other) in listing, listing
    chosen = run('choose', command + ['--resume', '--history'], '1\n')
    assert 'Keep the startup objective.' in chosen and 'Earlier 鹈鹕 context.' in chosen
    assert 'Conversation number or ID' in chosen and 'nomo> ' not in chosen

    resident = Client(command + ['--new', '--title', 'Resident'], environment, evidence, 'resident')
    worker = next(line.split('[WORKER ] ', 1)[1] for line in resident.output.decode().splitlines() if '[WORKER ] ' in line)
    before_pid, _ = execution_pid(worker)
    resident_id = status(resident.send('/status'))['id']
    inspected = status(run('inspect-resident', command + ['--id=' + imported['id'], '--status']))
    assert inspected['id'] == imported['id']
    assert status(run('latest', command + ['--latest', '--status']))['id'] == resident_id
    assert status(resident.send('/status'))['id'] == resident_id
    after_pid, _ = execution_pid(worker)
    assert before_pid == after_pid
    resident.leave()

    exported = []
    def approve_export(output):
        value = json.loads(next(line.split('[EXPORT ] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[EXPORT ] ' in line))
        assert value['path'] == 'exported.json' and json.loads(value['content'])['session']['id'] == imported['id'], value
        exported.append(value['content'])
    code, output, approvals, _ = terminal(command + ['--id', imported['id'], '--export', 'exported.json'], environment, [], project, approve=approve_export)
    (evidence / 'export-terminal.txt').write_text(output)
    assert code == 0 and approvals == 1 and (project / 'exported.json').read_text() == exported[0], output
    assert len(exported) == 1

    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    model_environment = dict(environment, NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1', NOMO_MODEL_ALLOW_PRIVATE='true')
    def approve_check(output):
        value = json.loads(next(line.split('[COMMAND] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line))
        assert value == {'program': CHECK[0], 'arguments': CHECK[1:]}, value
    try:
        code, output, approvals, _ = terminal(command + ['--id', imported['id'], '--high-input', '--once', '--root', '--check', *CHECK], model_environment, [], project, approve=approve_check)
        (evidence / 'check-terminal.txt').write_text(output)
        assert code == 0 and approvals == 1 and len(server.requests) == 2, output
        assert (project / 'check.txt').read_text() == 'startup check'
        assert 'Startup check override completed.' in output
    finally:
        server.shutdown(); server.server_close()
    traces = [json.loads(path.read_text()) for path in (evidence / 'traces').glob('run-*/trace.json')]
    assert all(trace['outcome']['kind'] == 'completed' for trace in traces)
    assert all(not audit(trace['events']) for trace in traces)
    model_requests = sum(event.get('request_kind') == 'model' and event['kind'] == 'host_request_started' for trace in traces for event in trace['events'])
    commands = sum(event.get('qualified_action') == 'Command.run' and event['kind'] == 'host_request_started' for trace in traces for event in trace['events'])
    assert model_requests == 2 and commands == 1
    (evidence / 'result.json').write_text(json.dumps({'status': 'passed', 'model_requests': model_requests,
        'native_commands': commands, 'native_approvals': 2, 'resident_pid_preserved': before_pid,
        'imported': imported, 'other': second, 'resident': resident_id, 'traces': len(traces)}, indent=2))
    print('PASS native startup selection, history, import/export, resident inspection and check override: ' + str(evidence))


if __name__ == '__main__':
    main()
