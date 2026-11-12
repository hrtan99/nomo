"""Interrupt a foreground native command; reconcile unknown outcomes, then chat."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import pty
import select
import subprocess
import tempfile
import threading

from native_recovery_probe import audit

ROOT = Path(__file__).resolve().parents[1]
ARGUMENTS = ['-c', "printf 'foreground started\\n' > command-marker.txt; exec /bin/sleep 30"]


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        if index == 0:
            name, arguments = 'run_command', {'program': '/bin/sh', 'arguments': ARGUMENTS}
        else:
            assert index == 1, 'an unresolved command must never be automatically replayed'
            turn = json.loads(next(item['content'] for item in request['messages'] if item['role'] == 'user'))
            recoveries = [item for item in turn['history'] if item['role'] == 'recovery']
            assert len(recoveries) == 2, recoveries
            assert all('Outcome remains unknown' in item['text'] for item in recoveries)
            assert any(item['name'] == 'command_outcome_unknown' for item in recoveries)
            assert any(item['name'] == 'read_file' and 'foreground started' in item['text'] for item in turn['history'])
            assert turn['pending'] == '' and turn['runs'] == []
            name, arguments = 'etas_emit_output', {'text': 'The inspected foreground marker is retained; the interrupted outcome remains unknown. No command was replayed.'}
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


def interrupt(command, environment, marker):
    master, slave = pty.openpty()
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output, sent, approved, stopped = bytearray(), False, False, False
    try:
        while True:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                if not sent and b'nomo> ' in output:
                    os.write(master, b'Run the synthetic foreground check once. Never replay it after interruption.\n')
                    sent = True
                if not approved and b'Type `yes` to approve:' in output:
                    preview = next(line.split('[COMMAND] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line)
                    assert json.loads(preview) == {'program': '/bin/sh', 'arguments': ARGUMENTS}
                    os.write(master, b'yes\n')
                    approved = True
            if not stopped and marker.exists():
                assert approved and process.poll() is None
                assert marker.read_text() == 'foreground started\n'
                os.write(master, b'\x03')
                stopped = True
            if process.poll() is not None and not ready:
                break
        code = process.wait()
    finally:
        os.close(master)
    assert approved and stopped and code != 0, output.decode()
    return code, output.decode()


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-attempt-recovery-')).resolve()
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
    base = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0135-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        base += ['--file', str(ROOT / name)]

    def command(tty, trace):
        return base + ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=' + str(tty).lower(), 'dev',
            '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
            '--allow-effects', '--trace-out', '/native-evidence/' + trace, '--args', '--workspace', str(project)]

    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        code, interrupted = interrupt(command(True, 'interrupted.json'), environment, project / 'command-marker.txt')
        (evidence / 'interrupted-terminal.txt').write_text(interrupted)
        assert len(server.requests) == 1
        commands = ['/runs', '/status', '/read command-marker.txt',
            '/resolve-run native-0-run-1 Old process exited and marker inspected; command result remains unknown.',
            '/resolve-run native-0-run-0 Old inference ended; continue only with a new user request.', '/runs', '/status',
            'Report the retained state without running another command.', '/runs', '/quit']
        recovered = subprocess.run(command(False, 'recovered.json'), cwd=ROOT, env=environment,
            input='\n'.join(commands) + '\n', text=True, capture_output=True)
        (evidence / 'recovered-stdout.txt').write_text(recovered.stdout)
        (evidence / 'recovered-stderr.txt').write_text(recovered.stderr)
        assert recovered.returncode == 0, recovered.stdout + recovered.stderr
        assert len(server.requests) == 2 and 'No command was replayed.' in recovered.stdout
        statuses = [json.loads(line.split('[STATUS ] ', 1)[1]) for line in recovered.stdout.splitlines() if '[STATUS ] ' in line]
        assert statuses[0]['pending'].endswith(' command') and statuses[1]['pending'] == ''
        runs = [json.loads(line.split('[RUN    ] ', 1)[1]) for line in recovered.stdout.splitlines() if '[RUN    ] {' in line]
        for kind in ('coding', 'command'):
            assert any(item['kind'] == kind and item['phase'] == 'dispatching' for item in runs), runs
            assert any(item['kind'] == kind and item['phase'] == 'closed_unknown' and item['recovery_event'] >= 0 for item in runs), runs
        assert any(item['kind'] == 'coding' and item['phase'] == 'completed' and item['result_event'] >= 0 for item in runs)
        assert (project / 'command-marker.txt').read_text() == 'foreground started\n'
        first = json.loads((traces / 'interrupted.json').read_text())
        final = json.loads((traces / 'recovered.json').read_text())
        assert first['outcome']['kind'] == 'cancelled' and final['outcome']['kind'] == 'completed'
        assert sum(item.get('qualified_action') == 'Command.run' and item['kind'] == 'host_request_started' for item in first['events']) == 1
        assert not any(item.get('qualified_action') == 'Command.run' for item in final['events'])
        failures = audit(first['events']) + audit(final['events'])
        (evidence / 'functional.json').write_text(json.dumps({'functional_status': 'passed', 'interrupted_exit': code,
            'model_http_requests': 2, 'native_command_dispatches': 1, 'recovery_command_dispatches': 0,
            'statuses': statuses, 'runs': runs, 'approval_audit': failures}, indent=2))
        print('FUNCTIONAL PASS native foreground interruption, unknown-outcome reconciliation and new chat: ' + str(evidence), flush=True)
        assert not failures, 'upstream Command approval provenance audit failed (#102); see functional.json'
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
