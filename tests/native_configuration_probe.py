"""Native TOML configuration, configured tools, summary and persisted cache."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import subprocess
import tempfile
import threading
import tomllib

from native_recovery_probe import terminal, audit
from native_navigation_probe import ROOT, COMMON, EXCLUDE

CONFIG = '''[project]
context_window = 400_000
max_output_tokens = 131_072
compact_ratio = 0.6
keep_messages = 2
command_timeout = 7
ignore = ["generated/**"]
instructions = [
  'Follow the configured coding style.',
  """Keep café characters and
scoped guidance.""",
]
check = ["python3", "-c", "print('configured check passed')"]
'''
TAPLO = '/home/nomo/.cargo/nomo-native-tools/taplo-0.10.0/bin/taplo'
FIND = COMMON + ['--files', '--sort', 'path', '--glob', '!generated/**'] + EXCLUDE + ['--', '.']
UPDATED = "instructions = ['Updated configured style.']\n[unrelated]\nenabled = true\n"


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        turn = json.loads(next(item['content'] for item in request['messages'] if item['role'] == 'user'))
        settings = turn['settings']
        assert settings['context_window'] == 400000 and settings['keep_messages'] == 2
        assert settings['compact_ratio'] == 0.6 and settings['command_timeout'] == 7
        assert any(item['text'] == 'Follow the configured coding style.' for item in turn['instructions'])
        assert any('café characters and\nscoped guidance.' in item['text'] for item in turn['instructions'])
        if index == 0:
            name, arguments = 'find_files', {'pathname': '.', 'glob': '', 'depth': 0}
        elif index == 1:
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            assert 'src/main.py' in result['stdout'] and 'generated/' not in result['stdout']
            name, arguments = 'check_project', {}
        elif index == 2:
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            assert result['configured'] and result['output'][0]['exit_code'] == 0
            assert result['output'][0]['stdout'] == 'configured check passed\n'
            name, arguments = 'etas_emit_output', {'text': 'Configured discovery and check completed.'}
        elif index == 3:
            name, arguments = 'etas_emit_output', {'text': 'Native configuration preserved; configured discovery and check completed.'}
        else:
            assert index == 4
            assert 'Native configuration preserved' in turn['summary']
            assert [item['role'] for item in turn['history']] == ['tool', 'assistant', 'user'], turn['history']
            name, arguments = 'etas_emit_output', {'text': 'Native settings and summary restored.'}
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


def approve_configuration(output):
    preview = next(line.split('[COMMAND] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line)
    value = json.loads(preview)
    if value['program'] == '/usr/bin/jq':
        assert value['arguments'] == ['-c', 'walk(if type == "object" then to_entries else . end)']
        assert json.loads(value['stdin']) in [tomllib.loads(CONFIG), tomllib.loads(UPDATED)]
        return
    assert value in [
        {'program': TAPLO, 'arguments': ['get', '-o', 'json'], 'stdin': CONFIG},
        {'program': TAPLO, 'arguments': ['get', '-o', 'json'], 'stdin': UPDATED},
        {'program': '/usr/bin/rg', 'arguments': FIND},
        {'program': '/usr/bin/python3', 'arguments': ['-c', "print('configured check passed')"]},
    ], value


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-configuration-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    (project / '.nomo.toml').write_text(CONFIG)
    (project / 'src').mkdir()
    (project / 'src/main.py').write_text('print("synthetic")\n')
    (project / 'generated').mkdir()
    (project / 'generated/ignored.txt').write_text('synthetic ignored file\n')
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.evidence = [], evidence
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1', NOMO_MODEL_ALLOW_PRIVATE='true',
        NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0131-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
        '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
        '--allow-effects', '--trace-out', '/native-evidence/trace.json', '--args', '--workspace', str(project)]
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        code, output, approvals, _ = terminal(command, environment,
            ['Discover files and run the configured project check.', '/compact', '/config', '/status', '/quit'],
            project, approve=approve_configuration)
        (evidence / 'terminal.txt').write_text(output)
        assert code == 0, output
        assert approvals == 4 and len(server.requests) == 4
        configuration = json.loads(next(line.split('[CONFIG ] ', 1)[1] for line in output.splitlines() if '[CONFIG ] {' in line))
        assert configuration['effective_context_window'] == 400000
        assert configuration['runtime_output_tokens'] == 131072 and configuration['command_timeout_active'] is False
        status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in output.splitlines() if '[STATUS ] ' in line))
        assert status['summary_through'] == 7 and status['ledger']['compactions'] == 1
        restored_command = [item.replace('--tty=true', '--tty=false').replace('/native-evidence/trace.json', '/native-evidence/restored.json') for item in command]
        restored = subprocess.run(restored_command, cwd=ROOT, env=environment,
            input='/config\nContinue with the saved summary and configuration.\n/quit\n', capture_output=True, text=True)
        (evidence / 'restored-stdout.txt').write_text(restored.stdout)
        (evidence / 'restored-stderr.txt').write_text(restored.stderr)
        assert restored.returncode == 0, restored.stdout + restored.stderr
        assert len(server.requests) == 5 and 'Native settings and summary restored.' in restored.stdout
        first = json.loads((traces / 'trace.json').read_text())
        final = json.loads((traces / 'restored.json').read_text())
        assert first['outcome']['kind'] == final['outcome']['kind'] == 'completed'
        assert sum(item.get('qualified_action') == 'Command.run' and item['kind'] == 'host_request_started' for item in first['events']) == 4
        assert not any(item.get('qualified_action') == 'Command.run' for item in final['events'])
        # Change the real fixture config after exit: root settings without a
        # [project] table, omitted defaults and an unrelated table stay valid.
        (project / '.nomo.toml').write_text(UPDATED)
        changed_command = [item.replace('/native-evidence/trace.json', '/native-evidence/changed.json') for item in command]
        changed_code, changed_text, changed_approvals, _ = terminal(changed_command, environment,
            ['/config', '/quit'], project, approve=approve_configuration)
        (evidence / 'changed-terminal.txt').write_text(changed_text)
        assert changed_code == 0 and changed_approvals == 2 and len(server.requests) == 5, changed_text
        updated = json.loads(next(line.split('[CONFIG ] ', 1)[1] for line in changed_text.splitlines() if '[CONFIG ] {' in line))
        assert updated['requested']['context_window'] == 1048576 and updated['requested']['keep_messages'] == 12
        assert updated['requested']['compact_ratio'] == 0.75 and updated['requested']['check'] == []
        assert updated['requested']['instructions'] == ['Updated configured style.']
        assert updated['context_window_is_estimate'] and updated['inference_token_allowance'] == 536870912
        assert updated['summary_token_allowance'] == 1048576
        changed = json.loads((traces / 'changed.json').read_text())
        assert changed['outcome']['kind'] == 'completed'
        failures = audit(first['events']) + audit(final['events']) + audit(changed['events'])
        (evidence / 'functional.json').write_text(json.dumps({'functional_status': 'passed', 'model_http_requests': 5,
            'native_command_dispatches': 4, 'restored_command_dispatches': 0, 'configuration': configuration,
            'changed_command_dispatches': 2, 'changed_configuration': updated,
            'status': status, 'approval_audit': failures}, indent=2))
        print('FUNCTIONAL PASS native configuration, configured tools, summary and cross-process cache: ' + str(evidence), flush=True)
        assert not failures, 'upstream Command approval provenance audit failed (#102); see functional.json'
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
