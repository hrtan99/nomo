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
import hashlib
import sys

ROOT = Path(__file__).resolve().parents[1]
LARGE_MESSAGE = 'x' * 2400000


class SyntheticModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = len(self.server.requests)
        self.server.requests.append(request)
        (self.server.evidence / f'request-{index}.json').write_text(json.dumps(request, indent=2))
        functions = [tool['function'] for tool in request['tools']]
        if self.server.scenario == 'auto':
            data = json.loads(next(message['content'] for message in reversed(request['messages']) if message['role'] == 'user'))
            assert data['initial_request'] == 'Remember the migration objective.'
            if index == 0:
                assert any(item['role'] == 'assistant' and item['text'] == LARGE_MESSAGE for item in data['history'])
                arguments = {'text': 'Automatic summary retained the migration objective and archived the large earlier message.'}
            else:
                assert data['summary'] == 'Automatic summary retained the migration objective and archived the large earlier message.'
                assert len(json.dumps(data).encode()) < 50000
                arguments = {'text': 'Native automatic compaction kept the objective.'}
            function = next(item for item in functions if item['name'] == 'etas_emit_output')
        elif self.server.scenario == 'persist' and index == 3:
            function = next(item for item in functions if item['name'] == 'etas_emit_output')
            arguments = {'text': 'Saved summary: note.txt changed from before old to before new after native approval.'}
        elif self.server.scenario in ('chat', 'persist') and index >= 3:
            data = json.loads(next(message['content'] for message in reversed(request['messages']) if message['role'] == 'user'))
            assert data['initial_request'] == 'Read note.txt and change old to new after approval.', data
            assert any(item['role'] == 'tool' and item['name'] == 'read_file' and 'before old' in item['text'] for item in data['history']), data
            assert any(item['role'] == 'tool' and item['name'] == 'replace_file' and 'applied' in item['text'] for item in data['history']), data
            if self.server.scenario == 'persist':
                assert data['summary'] == 'Saved summary: note.txt changed from before old to before new after native approval.', data
            function = next(item for item in functions if item['name'] == 'etas_emit_output')
            arguments = {'text': 'Native process restored full tool history and the saved summary.' if self.server.scenario == 'persist' else 'Native chat remembered the previous request and completed edit.'}
        elif self.server.scenario in ('files', 'chat', 'persist') and index == 0:
            function = next(item for item in functions if item['name'] == 'read_file')
            arguments = {'pathname': 'note.txt'}
        elif self.server.scenario in ('files', 'chat', 'persist') and index == 1:
            observation = next(message for message in request['messages'] if message['role'] == 'tool')
            assert 'before old' in observation['content'], observation
            function = next(item for item in functions if item['name'] == 'replace_file')
            arguments = {'change': {'path': 'note.txt', 'before': 'before old\n', 'after': 'before new\n'}}
        elif self.server.scenario in ('files', 'chat', 'persist'):
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
    parser.add_argument('--scenario', choices=('git', 'files', 'chat', 'persist', 'transfer', 'auto'), default='git')
    args = parser.parse_args()
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-' + args.scenario + '-')).resolve()
    project = evidence / 'project'
    project.mkdir()
    traces = evidence / 'native'
    traces.mkdir(mode=0o777)
    traces.chmod(0o777)
    state = evidence / 'state'
    state.mkdir(mode=0o777)
    state.chmod(0o777)
    subprocess.run(['git', 'init', '--initial-branch=main', str(project)], check=True, capture_output=True)
    (project / 'native.txt').write_text('native Git evidence\n')
    (project / 'note.txt').write_text('before old\n')
    if args.scenario in ('transfer', 'auto'):
        sys.path.insert(0, str(ROOT / 'scripts'))
        from nomo_history import SqliteHistory
        legacy = SqliteHistory(evidence / 'legacy-state')
        identifier = legacy.create(project, 'Earlier conversation')
        legacy.append(identifier, 'user', 'Remember the migration objective.')
        legacy.append(identifier, 'tool', '{"observed":"legacy file"}', name='read', data={'origin': 'legacy'})
        legacy.append(identifier, 'assistant', LARGE_MESSAGE if args.scenario == 'auto' else 'Earlier task saved.')
        legacy.compact(identifier, 1, 'Legacy summary preserved.')
        legacy.export(identifier, project / 'legacy.json')
        legacy_file = (project / 'legacy.json').read_bytes()
        legacy_database = hashlib.sha256(legacy.database.read_bytes()).hexdigest()
    server = ThreadingHTTPServer(('0.0.0.0', 0), SyntheticModel)
    server.requests, server.evidence, server.scenario = [], evidence, args.scenario
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1',
        NOMO_MODEL_ALLOW_PRIVATE='true', NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_EVIDENCE=str(traces), NOMO_NATIVE_STATE=str(state))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0120-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    request = 'Read note.txt and change old to new after approval.' if args.scenario in ('files', 'chat', 'persist') else 'Read Git status and report the branch and changed paths.'
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
        '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
        '--allow-effects', '--trace-out', '/native-evidence/trace.json', '--args', '--workspace', str(project)]
    if args.scenario not in ('chat', 'persist', 'transfer', 'auto'):
        command += ['--once', request]
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
                    if args.scenario in ('transfer', 'auto') and output.count(b'nomo> ') > sent_turns:
                        commands = ['/import legacy.json', 'Continue the task after the saved large history.', '/history', '/status', '/quit'] if args.scenario == 'auto' else [
                            '/import legacy.json', '/history', '/export roundtrip.json',
                            '/import roundtrip.json', '/history', '/status', '/quit']
                        os.write(master, (commands[sent_turns] + '\n').encode())
                        sent_turns += 1
                    elif args.scenario in ('chat', 'persist') and output.count(b'nomo> ') > sent_turns:
                        if sent_turns == 0:
                            os.write(master, (request + '\n').encode())
                        elif sent_turns == 1:
                            os.write(master, b'/compact\n' if args.scenario == 'persist' else b'What did you just complete?\n')
                        elif sent_turns == 2:
                            os.write(master, b'/history\n/status\n/quit\n')
                        sent_turns += 1
                    if not approved and b'Type `yes` to approve:' in output:
                        if args.scenario in ('files', 'chat', 'persist'):
                            preview = next(line for line in output.decode().splitlines() if line.startswith('[PREVIEW] '))
                            assert json.loads(preview[len('[PREVIEW] '):]) == {
                                'path': 'note.txt', 'before': 'before old\n', 'after': 'before new\n'}
                        if args.scenario == 'transfer':
                            line = next(line for line in output.decode().splitlines() if '[EXPORT ] ' in line)
                            preview = json.loads(line.split('[EXPORT ] ', 1)[1])
                            assert preview['path'] == 'roundtrip.json'
                            payload = json.loads(preview['content'])
                            assert payload['format'] == 'nomo-native-conversation-1'
                            assert any(item['name'] == 'imported_source' and item['text'] == legacy_file.decode() for item in payload['events'])
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
        assert not approved if args.scenario == 'auto' else approved
        if args.scenario == 'auto':
            assert len(server.requests) == 2
            assert '[CONTEXT] Summarizing; complete original history stays saved.' in text
            assert any(line.startswith('[assistant/ #') and line.split('] ', 1)[1] == LARGE_MESSAGE for line in text.splitlines())
            status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in text.splitlines() if '[STATUS ] ' in line))
            assert status['ledger']['compactions'] == 1 and status['ledger']['turns'] == 1
            assert status['ledger']['context_bytes'] < 50000
        elif args.scenario == 'transfer':
            assert len(server.requests) == 0
            assert (project / 'legacy.json').read_bytes() == legacy_file
            assert hashlib.sha256(legacy.database.read_bytes()).hexdigest() == legacy_database
            packet = json.loads((project / 'roundtrip.json').read_text())
            assert any(item['role'] == 'user' and item['text'] == 'Remember the migration objective.' for item in packet['events'])
            assert any(item['role'] == 'tool' and item['text'] == '{"observed":"legacy file"}' for item in packet['events'])
            assert 'Earlier task saved.' in text and 'Legacy summary preserved.' in text
            status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in text.splitlines() if '[STATUS ] ' in line))
            assert status['id'] == 'native-2' and status['pending'] == ''
            assert status['ledger']['turns'] == 0 and status['summary_event'] >= 0
        elif args.scenario == 'persist':
            assert (state / 'conversations.sqlite3').is_file()
            assert '[tool/replace_file' in text and 'applied' in text
            status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in text.splitlines() if '[STATUS ] ' in line))
            assert status['ledger']['turns'] == 1 and status['ledger']['compactions'] == 1
            assert status['ledger']['tools'] == 2 and status['pending'] == ''
            restored = list(command)
            restored[restored.index('--tty=true')] = '--tty=false'
            restored[restored.index('/native-evidence/trace.json')] = '/native-evidence/trace-restored.json'
            restored += ['--once', 'What did you just complete?']
            result = subprocess.run(restored, cwd=ROOT, env=environment, capture_output=True, text=True)
            (evidence / 'restored-stdout.txt').write_text(result.stdout)
            (evidence / 'restored-stderr.txt').write_text(result.stderr)
            assert result.returncode == 0, result.stdout + result.stderr
            assert 'Native process restored full tool history and the saved summary.' in result.stdout
            assert len(server.requests) == 5, len(server.requests)
        elif args.scenario in ('files', 'chat'):
            assert len(server.requests) == (4 if args.scenario == 'chat' else 3), len(server.requests)
            assert (project / 'note.txt').read_text() == 'before new\n'
            assert 'Native file edit applied after approval.' in text, text
            if args.scenario == 'chat':
                assert 'Native chat remembered the previous request and completed edit.' in text, text
        else:
            assert len(server.requests) == 2, len(server.requests)
            assert 'Observed main and the untracked native.txt' in text, text
        assert (traces / 'trace.json').is_file()
        trace = json.loads((traces / 'trace.json').read_text())
        if args.scenario in ('files', 'chat', 'persist'):
            events = trace['events']
            approval = next(index for index, event in enumerate(events)
                            if event['kind'] == 'host_request_started' and event['request_kind'] == 'approval')
            write = next(index for index, event in enumerate(events)
                         if event['kind'] == 'host_request_started' and event['qualified_action'] == 'Fs.atomic_replace')
            assert approval < write
            assert events[write]['authority']['approval_count'] == 1
            assert trace['outcome']['kind'] == 'completed'
        label = 'legacy import + reviewed export + native reimport; no model calls' if args.scenario == 'transfer' else args.scenario + ' native conversation flow'
        print('PASS native ' + label + ': ' + str(evidence))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
