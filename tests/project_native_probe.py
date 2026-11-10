"""One positive native project loop against a local synthetic model server."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from nomo_project_chat import ProjectApplication, empty_action


class SyntheticModel(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        (self.server.evidence / ('request-' + str(self.server.calls) + '.json')).write_text(json.dumps(request, ensure_ascii=False, indent=2))
        function = request['tools'][0]['function']
        output = self.server.responses.pop(0)
        self.server.calls += 1
        body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': None,
            'tool_calls': [{'id': 'synthetic-output', 'type': 'function', 'function': {'name': function['name'],
                'arguments': json.dumps(output, ensure_ascii=False)}}]}, 'finish_reason': 'tool_calls'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-project-native-')).resolve()
    root = evidence / 'project'; root.mkdir()
    batch = empty_action('batch')
    batch['changes'] = [{'operation': 'create', 'path': 'index.html', 'target': '', 'text': '<h1>Pelican</h1>\n'},
                        {'operation': 'create', 'path': 'README.md', 'target': '', 'text': 'Open index.html\n'}]
    check = empty_action('exec')
    check['arguments'] = [sys.executable, '-c', 'from pathlib import Path; assert "Pelican" in Path("index.html").read_text(); print("PASS")']
    answer = empty_action('answer'); answer['text'] = 'Created two files; check passed.'
    resumed_answer = empty_action('answer'); resumed_answer['text'] = 'Restored the saved summary and verified history.'
    server = ThreadingHTTPServer(('0.0.0.0', 0), SyntheticModel)
    server.calls = 0
    server.evidence = evidence
    server.responses = [empty_action('tree'), batch, check, answer, {'text': 'Created index.html and README.md, verified PASS. Task complete.'}, resumed_answer]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ.update(MINIMAX_API_KEY='synthetic-local-only', NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1',
                      NOMO_MODEL_ALLOW_PRIVATE='true')
    app = ProjectApplication(evidence / 'state', root, approve=lambda preview: True)
    try:
        assert app.ask('Create a synthetic Pelican page and README, then verify') == answer['text']
        app.context.compact(force=True)
        assert (root / 'index.html').read_text() == '<h1>Pelican</h1>\n'
        assert (root / 'README.md').read_text() == 'Open index.html\n'
        outcomes = [json.loads(row['content']) for row in app.history.events(app.session) if row['role'] == 'tool' and row['name'] == 'exec']
        assert outcomes[0]['exit_code'] == 0 and 'PASS' in outcomes[0]['output']
        assert app.history.session(app.session)['summary']
        identifier = app.session
        app.close()
        app = ProjectApplication(evidence / 'state', root, identifier)
        assert app.ask('Summarize the completed task from saved history, without changing files.') == resumed_answer['text']
        request = json.loads((evidence / 'request-5.json').read_text())
        data = json.loads(next(message['content'] for message in reversed(request['messages']) if message['role'] == 'user'))
        assert data['context']['history'][0]['name'] == 'conversation_summary'
        assert 'Create a synthetic Pelican page' in data['context']['initial_request']
        assert server.calls == 6
        print('PASS native tools + batch + command + full history + model compaction + process restart: ' + str(evidence))
    finally:
        app.close(); server.shutdown(); server.server_close()


if __name__ == '__main__':
    main()
