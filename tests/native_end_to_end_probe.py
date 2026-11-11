"""Continuous native read/edit/check/Git/chat/exit/new-process acceptance.

Python provides synthetic model replies, fixture setup, terminal transport and
assertions only. The Etas process dispatches and executes every product tool.
"""
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
REQUEST = 'Read note.txt, change old to new after approval, run the file check, inspect all Git views, create and switch to accepted, and commit note.txt as Native acceptance.'
CHECK = "from pathlib import Path; assert Path('note.txt').read_text() == 'before new\\n'; print('check passed')"
STEPS = [
    ('read_file', {'pathname': 'note.txt'}),
    ('replace_file', {'change': {'path': 'note.txt', 'before': 'before old\n', 'after': 'before new\n'}}),
    ('run_command', {'program': '/usr/bin/python3', 'arguments': ['-c', CHECK]}),
    ('git_status', {}),
    ('git_diff', {'staged': False, 'paths': ['note.txt']}),
    ('git_init', {}),
    ('git_branch', {'name': 'accepted'}),
    ('git_switch', {'name': 'accepted'}),
    ('git_commit', {'message': 'Native acceptance', 'paths': ['note.txt']}),
    ('git_log', {'count': 1}),
    ('git_branches', {}),
    ('git_diff', {'staged': True, 'paths': []}),
]


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        if 0 < index <= len(STEPS):
            observation = json.loads(next(message['content'] for message in reversed(request['messages']) if message['role'] == 'tool'))
            if index == 1:
                assert observation['text'] == 'before old\n', observation
            elif index == 2:
                assert observation['status'] == 'applied', observation
            else:
                assert observation['exit_code'] == 0, observation
                if index == 3:
                    assert observation['stdout'] == 'check passed\n', observation
                elif index == 4:
                    assert 'note.txt' in observation['stdout'], observation
                elif index == 5:
                    assert '-before old' in observation['stdout'] and '+before new' in observation['stdout'], observation
                elif index == 6:
                    assert 'Reinitialized' in observation['stdout'], observation
                elif index == 8:
                    assert 'accepted' in observation['stderr'], observation
                elif index in (9, 10):
                    assert 'Native acceptance' in observation['stdout'], observation
                elif index == 11:
                    assert '* accepted' in observation['stdout'] and 'main' in observation['stdout'], observation
                elif index == 12:
                    assert observation['stdout'] == '', observation
        if index < len(STEPS):
            name, arguments = STEPS[index]
        else:
            name, arguments = 'etas_emit_output', {'text': 'Native read, approved edit, check and Git commit completed.'}
            if index > len(STEPS):
                data = json.loads(next(message['content'] for message in reversed(request['messages']) if message['role'] == 'user'))
                assert data['initial_request'] == REQUEST, data
                assert data['session'] == 'native-0' and data['pending'] == '', data
                assert any(item['role'] == 'tool' and 'check passed' in item['text'] for item in data['history']), data
                assert any(item['role'] == 'tool' and 'Native acceptance' in item['text'] for item in data['history']), data
                arguments = {'text': 'Native history retained the approved edit, successful check and accepted branch commit.'}
        assert index < 15, index
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
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-end-to-end-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    (project / 'note.txt').write_text('before old\n')
    for arguments in (['init', '--initial-branch=main'], ['config', 'user.name', 'Synthetic Fixture'],
                      ['config', 'user.email', 'fixture@example.invalid'], ['config', 'commit.gpgsign', 'false'],
                      ['add', 'note.txt'], ['commit', '-m', 'Initial synthetic fixture']):
        subprocess.run(['git', '-C', str(project), *arguments], check=True, capture_output=True)
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.evidence = [], evidence
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1', NOMO_MODEL_ALLOW_PRIVATE='true',
        NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0130-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
        '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
        '--allow-effects', '--max-tool-rounds', '256', '--trace-out', '/native-evidence/trace.json', '--args', '--workspace', str(project)]
    git_commands = [
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch'],
        ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--', 'note.txt'],
        ['init', '--initial-branch=main'], ['branch', '--', 'accepted'], ['switch', '--', 'accepted'],
        ['add', '--', 'note.txt'], ['commit', '-m', 'Native acceptance'],
        ['--no-optional-locks', 'log', '--oneline', '-n', '1'], ['--no-optional-locks', 'branch', '--list'],
        ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--cached', '--'],
    ]
    approvals = [{'path': 'note.txt', 'before': 'before old\n', 'after': 'before new\n'},
                 {'program': '/usr/bin/python3', 'arguments': ['-c', CHECK]}]
    approvals += [{'program': '/usr/bin/git', 'arguments': arguments} for arguments in git_commands]
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        master, slave = pty.openpty()
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output, sent, approved, business_approved = bytearray(), 0, 0, 0
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
                    if sent < 3 and output.count(b'nomo> ') > sent:
                        turns = [REQUEST + '\n', 'What did you complete on the accepted branch?\n', '/history\n/status\n/quit\n']
                        os.write(master, turns[sent].encode())
                        sent += 1
                    if output.count(b'Type `yes` to approve:') > approved:
                        previews = [line for line in output.decode().splitlines() if '[PREVIEW] ' in line or '[COMMAND] ' in line]
                        line = previews[-1]
                        value = json.loads(line.split('[PREVIEW] ' if '[PREVIEW] ' in line else '[COMMAND] ', 1)[1])
                        if value.get('program') in ('/bin/cp', '/bin/mkdir'):
                            from native_mutations_probe import approve_preview
                            approve_preview(output)
                        else:
                            assert value == approvals[business_approved], value
                            business_approved += 1
                        os.write(master, b'yes\n')
                        approved += 1
                elif process.poll() is not None:
                    break
            code = process.wait()
        finally:
            os.close(master)
        text = output.decode()
        (evidence / 'terminal.txt').write_text(text)
        (evidence / 'command.json').write_text(json.dumps(command, indent=2))
        assert code == 0, text
        assert business_approved == len(approvals) and len(server.requests) == 14
        assert (project / 'note.txt').read_text() == 'before new\n'
        assert subprocess.check_output(['git', '-C', str(project), 'branch', '--show-current'], text=True).strip() == 'accepted'
        assert subprocess.check_output(['git', '-C', str(project), 'status', '--porcelain'], text=True) == ''
        restored = list(command)
        restored[restored.index('--tty=true')] = '--tty=false'
        restored[restored.index('/native-evidence/trace.json')] = '/native-evidence/restored.json'
        restored += ['--once', 'Restore the conversation and describe the completed work.']
        result = subprocess.run(restored, cwd=ROOT, env=environment, capture_output=True, text=True)
        (evidence / 'restored-stdout.txt').write_text(result.stdout)
        (evidence / 'restored-stderr.txt').write_text(result.stderr)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'Native history retained' in result.stdout and len(server.requests) == 15
        for name in ('trace.json', 'restored.json'):
            trace = json.loads((traces / name).read_text())
            assert trace['outcome']['kind'] == 'completed'
            from native_recovery_probe import audit
            assert not audit(trace['events']), 'native approval provenance audit failed'
        print('PASS complete native read/edit/check/Git/chat/restore: ' + str(evidence))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
