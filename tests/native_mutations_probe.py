"""One native batch and undo flow with text, binary, directories and modes."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import pty
import re
import select
import stat
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
CHANGES = [
    {'operation': 'create', 'path': 'new/sub/index.html', 'target': '', 'text': '<h1>Pelican</h1>\n'},
    {'operation': 'edit', 'path': 'note.txt', 'target': 'old', 'text': 'new'},
    {'operation': 'mkdir', 'path': 'extra', 'target': '', 'text': ''},
    {'operation': 'move', 'path': 'move.bin', 'target': 'new/sub/moved.bin', 'text': ''},
    {'operation': 'delete', 'path': 'delete-dir', 'target': '', 'text': ''},
]
BINARY = bytes([0, 255, 1, 128, 10])


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        project = self.server.project
        if index == 0:
            name, arguments = 'apply_changes', {'changes': CHANGES}
        elif index == 1:
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            assert result['status'] == 'applied' and result['completed'] == 7, result
            self.server.edit = result['edit']
            assert (project / 'note.txt').read_text() == 'before new\n'
            assert (project / 'new/sub/index.html').read_text() == '<h1>Pelican</h1>\n'
            assert (project / 'new/sub/moved.bin').read_bytes() == BINARY
            assert not (project / 'move.bin').exists() and not (project / 'delete-dir').exists()
            name, arguments = 'etas_emit_output', {'text': 'Native batch applied.'}
        elif index == 2:
            name, arguments = 'undo_changes', {'edit': self.server.edit}
        else:
            assert index == 3, index
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            assert result['status'] == 'undone', result
            assert (project / 'note.txt').read_text() == 'before old\n'
            assert (project / 'move.bin').read_bytes() == BINARY
            assert (project / 'delete-dir/program').read_bytes() == BINARY
            assert stat.S_IMODE((project / 'delete-dir/program').stat().st_mode) == 0o751
            assert not (project / 'new').exists() and not (project / 'extra').exists()
            name, arguments = 'etas_emit_output', {'text': 'Native undo restored text, binary files, directories and file mode.'}
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


def approve_preview(output):
    lines = output.decode().splitlines()
    preview = next(line for line in reversed(lines) if '[COMMAND] ' in line or '[PREVIEW] ' in line)
    if '[PREVIEW] ' in preview:
        value = json.loads(preview.split('[PREVIEW] ', 1)[1])
        assert value in ({'path': 'new/sub/index.html', 'before': '', 'after': '<h1>Pelican</h1>\n'},
                         {'path': 'note.txt', 'before': 'before old\n', 'after': 'before new\n'}), value
        return
    value = json.loads(preview.split('[COMMAND] ', 1)[1])
    program, arguments = value['program'], value['arguments']
    paths = {'new', 'new/sub', 'new/sub/index.html', 'note.txt', 'move.bin', 'new/sub/moved.bin', 'extra', 'delete-dir'}
    backup = re.compile(r'/native-state/edits/native-0-[0-9]+(?:/[0-9]+-[01]\.(?:before|after))?')
    if program == '/bin/mkdir':
        assert arguments[:2] == ['-p', '--'] and (arguments[2] in paths or backup.fullmatch(arguments[2])), value
    elif program == '/bin/cp':
        assert arguments[:2] == ['-a', '--'] and len(arguments) == 4, value
        assert all(item in paths or backup.fullmatch(item) for item in arguments[2:]), value
        assert any(backup.fullmatch(item) for item in arguments[2:]), value
    elif program == '/bin/rm':
        assert arguments[:2] == ['-rf', '--'] and arguments[2] in paths, value
    elif program == '/bin/mv':
        assert arguments == ['-T', '--no-clobber', '--', 'move.bin', 'new/sub/moved.bin'], value
    elif program == '/usr/bin/diff':
        assert arguments[:3] == ['-r', '--no-dereference', '--'] and arguments[3] in paths and backup.fullmatch(arguments[4]), value
    else:
        raise AssertionError(value)


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-mutations-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    (project / 'note.txt').write_text('before old\n')
    (project / 'move.bin').write_bytes(BINARY)
    (project / 'delete-dir').mkdir()
    (project / 'delete-dir/program').write_bytes(BINARY)
    (project / 'delete-dir/program').chmod(0o751)
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.evidence, server.project = [], evidence, project
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
        master, slave = pty.openpty()
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output, sent, approvals = bytearray(), 0, 0
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
                        turns = ['Apply the related synthetic file changes with native undo.\n', 'Undo that batch.\n', '/edits\n/status\n/quit\n']
                        os.write(master, turns[sent].encode())
                        sent += 1
                    if output.count(b'Type `yes` to approve:') > approvals:
                        approve_preview(output)
                        os.write(master, b'yes\n')
                        approvals += 1
                elif process.poll() is not None:
                    break
            code = process.wait()
        finally:
            os.close(master)
        text = output.decode()
        (evidence / 'terminal.txt').write_text(text)
        (evidence / 'command.json').write_text(json.dumps(command, indent=2))
        assert code == 0, text
        assert len(server.requests) == 4 and approvals > 0
        assert 'Native undo restored' in text and '"phase":"undone"' in text
        status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in text.splitlines() if '[STATUS ] ' in line))
        assert status['pending'] == '' and status['ledger']['tools'] == 2, status
        trace = json.loads((traces / 'trace.json').read_text())
        assert trace['outcome']['kind'] == 'completed'
        approval = None
        for event in trace['events']:
            if event['kind'] == 'host_request_started' and event.get('qualified_action') == 'Approval.request':
                approval = event
            elif event['kind'] == 'host_request_started' and event.get('qualified_action') in ('Command.run', 'Fs.atomic_replace'):
                assert approval is not None, event
                assert event['authority']['approval_count'] == approval['authority']['approval_count'] + 1, event
                approval = None
        print('PASS native batch + binary/directory/mode undo: ' + str(evidence))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
