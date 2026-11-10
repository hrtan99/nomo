"""Local synthetic replies only; no upstream provider or real credential."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json


class Model(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = Model.calls
        Model.calls += 1
        name = 'tick' if index < 9 else 'etas_emit_output'
        assert any(tool['function']['name'] == name for tool in request['tools'])
        arguments = {'value': index} if index < 9 else {'text': 'All nine tools completed.'}
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


HTTPServer(('127.0.0.1', 18097), Model).serve_forever()
