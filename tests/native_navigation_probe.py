"""Native discovery -> glob -> regex -> scoped instructions -> read -> result."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import pty
import select
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
COMMON = ['--hidden', '--no-require-git', '--color', 'never']
EXCLUDE = ['--glob', '!**/.git/**', '--glob', '!**/.nomo/**']
COMMANDS = [
    COMMON + ['--files', '--sort', 'path'] + EXCLUDE + ['--', '.'],
    COMMON + ['--files', '--sort', 'path', '--glob', '**/*.py'] + EXCLUDE + ['--', '.'],
    COMMON + ['--line-number', '--with-filename', '--no-heading', '--sort', 'path'] + EXCLUDE + ['--', 'Pelican (cycles|rides)', '.'],
]


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        assert 'ROOT native project rule' in json.dumps(request['messages'])
        if index:
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            if index < 4:
                assert result['exit_code'] == 0, result
                output = result['stdout']
                assert 'src/with space.py' in output, result
                assert '.git/' not in output and '.nomo/' not in output, result
                if index != 2:
                    assert 'ignored.py' not in output, result
                if index == 1:
                    assert 'docs/page.html' in output, result
                elif index == 2:
                    assert 'docs/page.html' not in output, result
                else:
                    assert 'src/with space.py:2:Pelican cycles' in output and 'docs/page.html:1:Pelican rides' in output, result
            elif index == 4:
                assert [item['path'] for item in result] == ['AGENTS.md', 'src/AGENTS.md'], result
                assert [item['scope'] for item in result] == ['.', 'src'], result
                assert result[1]['text'] == 'NESTED native project rule\n', result
            else:
                assert result['text'] == '# Synthetic project\nPelican cycles\n', result
                assert [item['path'] for item in result['instructions']] == ['AGENTS.md', 'src/AGENTS.md'], result
        plan = [
            ('find_files', {'pathname': '.', 'glob': '', 'depth': 0}),
            ('find_files', {'pathname': '.', 'glob': '**/*.py', 'depth': 0}),
            ('search_project', {'pathname': '.', 'pattern': 'Pelican (cycles|rides)', 'regex': True}),
            ('project_instructions', {'pathname': 'src/with space.py'}),
            ('read_file', {'pathname': 'src/with space.py'}),
            ('etas_emit_output', {'text': 'Native discovery, scoped project instructions and file read completed.'}),
        ]
        name, arguments = plan[index]
        assert any(tool['function']['name'] == name for tool in request['tools'])
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
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-navigation-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    for name, content in {
        '.gitignore': 'ignored.py\n', 'src/with space.py': '# Synthetic project\nPelican cycles\n',
        'AGENTS.md': 'ROOT native project rule\n', 'src/AGENTS.md': 'NESTED native project rule\n',
        'docs/page.html': 'Pelican rides\n', 'ignored.py': 'Ignored Pelican cycles\n',
        '.git/internal.py': 'Internal\n', '.nomo/internal.py': 'Internal\n',
    }.items():
        target = project / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.evidence = [], evidence
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1', NOMO_MODEL_ALLOW_PRIVATE='true',
        NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0133-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
        '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
        '--allow-effects', '--trace-out', '/native-evidence/trace.json', '--args', '--workspace', str(project),
        '--once', 'Find project files, locate the cycling pelican with a regex and read the matching Python file.']
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        master, slave = pty.openpty()
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output, approvals = bytearray(), 0
        try:
            while True:
                ready, _, _ = select.select([master], [], [], 1)
                if ready:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
                    if output.count(b'Type `yes` to approve:') > approvals:
                        preview = next(line.split('[COMMAND] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line)
                        assert json.loads(preview) == {'program': '/usr/bin/rg', 'arguments': COMMANDS[approvals]}
                        os.write(master, b'yes\n')
                        approvals += 1
                elif process.poll() is not None:
                    break
            code = process.wait()
        finally:
            os.close(master)
        (evidence / 'terminal.txt').write_bytes(output)
        assert code == 0, output.decode()
        assert len(server.requests) == 6 and approvals == 3
        trace = json.loads((traces / 'trace.json').read_text())
        assert trace['outcome']['kind'] == 'completed'
        (evidence / 'functional.json').write_text(json.dumps({'status': 'passed', 'http_requests': 6, 'native_command_approvals': 3, 'provider_tokens': 'synthetic, not measured usage', 'scoped_instructions': 'root plus src guidance returned by native tool and read_file'}))
        print('FUNCTIONAL PASS native navigation: ' + str(evidence), flush=True)
        approval = None
        for event in trace['events']:
            if event['kind'] == 'host_request_started' and event.get('qualified_action') == 'Approval.request':
                approval = event
            elif event['kind'] == 'host_request_started' and event.get('qualified_action') == 'Command.run':
                assert approval is not None
                assert event['authority']['approval_count'] == approval['authority']['approval_count'] + 1, 'upstream etas-interpreter#102: stale Command approval authority'
                approval = None
        print('PASS native navigation and approval provenance: ' + str(evidence))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
