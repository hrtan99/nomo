"""Native tool/Host/model acceptance using a local synthetic model."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import subprocess
import tempfile
import threading
import argparse
import pty
import select

ROOT = Path(__file__).resolve().parents[1]


class SyntheticModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        functions = [tool['function'] for tool in request['tools']]
        if self.server.scenario == 'chat' and index == 3:
            data = json.loads(next(message['content'] for message in reversed(request['messages']) if message['role'] == 'user'))
            assert data['history'] == [
                {'role': 'user', 'text': 'Read note.txt and change old to new after approval.'},
                {'role': 'assistant', 'text': 'Native file edit applied after approval.'}], data
            function = next(item for item in functions if item['name'] == 'etas_emit_output')
            arguments = {'text': 'Native chat remembered the previous request and completed edit.'}
        elif self.server.scenario in ('files', 'chat') and index == 0:
            function = next(item for item in functions if item['name'] == 'read_file')
            arguments = {'pathname': 'note.txt'}
        elif self.server.scenario in ('files', 'chat') and index == 1:
            observation = next(message for message in request['messages'] if message['role'] == 'tool')
            assert 'before old' in observation['content'], observation
            function = next(item for item in functions if item['name'] == 'replace_file')
            arguments = {'change': {'path': 'note.txt', 'before': 'before old\n', 'after': 'before new\n'}}
        elif self.server.scenario in ('files', 'chat'):
            observation = [message for message in request['messages'] if message['role'] == 'tool'][-1]
            assert 'applied' in observation['content'], observation
            function = next(item for item in functions if item['name'] == 'etas_emit_output')
            arguments = {'text': 'Native file edit applied after approval.'}
        elif index == 0:
            function = next(item for item in functions if 'git_status' in item['name'])
            arguments = {}
        else:
            observation = next(message for message in request['messages'] if message['role'] == 'tool')
            assert 'native.txt' in observation['content'], observation
            assert 'main' in observation['content'], observation
            function = next(item for item in functions if item['name'] == 'etas_emit_output')
            arguments = {'text': 'Observed main and the untracked native.txt through native Git.'}
        response = {'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': [{
            'id': f'native-{index}', 'type': 'function', 'function': {
                'name': function['name'], 'arguments': json.dumps(arguments)}}]}, 'finish_reason': 'tool_calls'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', choices=('git', 'files', 'chat'), default='git')
    args = parser.parse_args()
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-' + args.scenario + '-')).resolve()
    project = evidence / 'project'
    project.mkdir()
    traces = evidence / 'native'
    traces.mkdir(mode=0o777)
    traces.chmod(0o777)
    subprocess.run(['git', 'init', '--initial-branch=main', str(project)], check=True, capture_output=True)
    (project / 'native.txt').write_text('native Git evidence\n')
    (project / 'note.txt').write_text('before old\n')
    server = ThreadingHTTPServer(('0.0.0.0', 0), SyntheticModel)
    server.requests, server.evidence, server.scenario = [], evidence, args.scenario
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1',
        NOMO_MODEL_ALLOW_PRIVATE='true', NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0120-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    request = 'Read note.txt and change old to new after approval.' if args.scenario in ('files', 'chat') else 'Read Git status and report the branch and changed paths.'
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
        '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
        '--allow-effects', '--trace-out', '/native-evidence/trace.json']
    if args.scenario != 'chat':
        command += ['--args', request]
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        master, slave = pty.openpty()
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output, approved, sent_turns = bytearray(), False, 0
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
                    if args.scenario == 'chat' and output.count(b'nomo> ') > sent_turns:
                        if sent_turns == 0:
                            os.write(master, (request + '\n').encode())
                        elif sent_turns == 1:
                            os.write(master, b'What did you just complete?\n')
                        elif sent_turns == 2:
                            os.write(master, b'/history\n/quit\n')
                        sent_turns += 1
                    if not approved and b'Type `yes` to approve:' in output:
                        if args.scenario in ('files', 'chat'):
                            preview = next(line for line in output.decode().splitlines() if line.startswith('[PREVIEW] '))
                            assert json.loads(preview[len('[PREVIEW] '):]) == {
                                'path': 'note.txt', 'before': 'before old\n', 'after': 'before new\n'}
                        os.write(master, b'yes\n')
                        approved = True
                elif process.poll() is not None:
                    break
            code = process.wait()
        finally:
            os.close(master)
        text = output.decode()
        (evidence / 'terminal.txt').write_text(text)
        (evidence / 'command.json').write_text(json.dumps(command, indent=2))
        assert code == 0, text
        assert approved
        if args.scenario in ('files', 'chat'):
            assert len(server.requests) == (4 if args.scenario == 'chat' else 3), len(server.requests)
            assert (project / 'note.txt').read_text() == 'before new\n'
            assert 'Native file edit applied after approval.' in text, text
            if args.scenario == 'chat':
                assert '[assistant] Native chat remembered the previous request and completed edit.' in text, text
        else:
            assert len(server.requests) == 2, len(server.requests)
            assert 'Observed main and the untracked native.txt' in text, text
        assert (traces / 'trace.json').is_file()
        trace = json.loads((traces / 'trace.json').read_text())
        if args.scenario in ('files', 'chat'):
            events = trace['events']
            approval = next(index for index, event in enumerate(events)
                            if event['kind'] == 'host_request_started' and event['request_kind'] == 'approval')
            write = next(index for index, event in enumerate(events)
                         if event['kind'] == 'host_request_started' and event['qualified_action'] == 'Fs.atomic_replace')
            assert approval < write
            assert events[write]['authority']['approval_count'] == 1
            assert trace['outcome']['kind'] == 'completed'
        print('PASS native ' + args.scenario + ' tool -> Host -> model continuation: ' + str(evidence))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
