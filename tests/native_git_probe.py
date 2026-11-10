"""Positive native Git coverage through the environment-only launcher.

This short prepared-index task is separate from the unchanged full-workflow
acceptance. Python supplies fixtures, a synthetic HTTP model and terminal I/O.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import subprocess
import tempfile
import threading

from native_recovery_probe import terminal, audit

ROOT = Path(__file__).resolve().parents[1]
REQUEST = 'Inspect the prepared staged diff, commit note.txt and extra.txt as Native Git coverage, then show the latest commit and local branches.'
STEPS = [
    ('git_diff', {'staged': True, 'paths': ['note.txt']}),
    ('git_commit', {'message': 'Native Git coverage', 'paths': ['note.txt', 'extra.txt']}),
    ('git_log', {'count': 1}),
    ('git_branches', {}),
]
ARGV = [
    ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--cached', '--', 'note.txt'],
    ['add', '--', 'note.txt', 'extra.txt'],
    ['commit', '-m', 'Native Git coverage'],
    ['--no-optional-locks', 'log', '--oneline', '-n', '1'],
    ['--no-optional-locks', 'branch', '--list'],
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
            result = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'tool'))
            assert result['exit_code'] == 0 and result['stderr'] == '', result
            if index == 1:
                assert '-before old' in result['stdout'] and '+before new' in result['stdout'], result
            elif index in (2, 3):
                assert 'Native Git coverage' in result['stdout'], result
            else:
                assert result['stdout'] == '* main\n', result
        if index < len(STEPS):
            name, arguments = STEPS[index]
        else:
            assert index < 7, index
            name, arguments = 'etas_emit_output', {'text': 'Native staged diff, selected-path commit, log and branch listing completed.'}
            if index >= 5:
                data = json.loads(next(item['content'] for item in reversed(request['messages']) if item['role'] == 'user'))
                assert data['session'] == 'native-0' and data['initial_request'] == REQUEST and data['pending'] == '', data
                assert any(item['role'] == 'tool' and 'Native Git coverage' in item['text'] for item in data['history']), data
                arguments = {'text': 'The native conversation retained the actual Git results across turns and restart.'}
        assert any(item['function']['name'] == name for item in request['tools'])
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
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-git-')).resolve()
    project, state, traces = (evidence / name for name in ('project 鹈鹕', 'state', 'traces'))
    project.mkdir(mode=0o700)
    (project / 'note.txt').write_text('before old\n')
    def git(*arguments):
        return subprocess.run(['git', '-C', str(project), *arguments], check=True, capture_output=True, text=True).stdout
    for arguments in (['init', '--initial-branch=main'], ['config', 'user.name', 'Synthetic Fixture'],
                      ['config', 'user.email', 'fixture@example.invalid'], ['config', 'commit.gpgsign', 'false'],
                      ['add', 'note.txt'], ['commit', '-m', 'Initial synthetic fixture']):
        git(*arguments)
    (project / 'note.txt').write_text('before new\n')
    (project / 'extra.txt').write_text('synthetic selected path\n')
    git('add', 'note.txt')
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.evidence = [], evidence
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1', NOMO_MODEL_ALLOW_PRIVATE='true',
        NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_TRACE_ROOT=str(traces))
    command = [str(ROOT / 'scripts/nomo-native'), str(project)]
    approved = []
    def approve_git(output):
        preview = next(line.split('[COMMAND] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line)
        value = json.loads(preview)
        assert value == {'program': '/usr/bin/git', 'arguments': ARGV[len(approved)]}, value
        approved.append(value)
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        code, output, approvals, _ = terminal(command + ['--new'], environment,
            [REQUEST, 'What did you commit?', '/history', '/status', '/runs', '/quit'], project, approve=approve_git)
        (evidence / 'terminal.txt').write_text(output)
        assert code == 0 and approvals == 5 and len(server.requests) == 6, output
        assert git('status', '--porcelain') == ''
        assert git('log', '-1', '--format=%s').strip() == 'Native Git coverage'
        assert git('rev-list', '--count', 'HEAD').strip() == '2'
        assert git('show', 'HEAD:extra.txt') == 'synthetic selected path\n'
        code, restored, restore_approvals, _ = terminal(command + ['--resume', 'native-0'], environment,
            ['What Git work did this conversation complete?', '/history', '/status', '/runs', '/quit'], project, approve=approve_git)
        (evidence / 'restored-terminal.txt').write_text(restored)
        assert code == 0 and restore_approvals == 0 and len(server.requests) == 7, restored
        trace_paths = [Path(next(line.split('[TRACE  ] ', 1)[1] for line in text.splitlines() if '[TRACE  ] ' in line)) / 'trace.json'
                       for text in (output, restored)]
        assert trace_paths[0] != trace_paths[1]
        failures, dispatches = [], 0
        for path in trace_paths:
            trace = json.loads(path.read_text())
            assert trace['outcome']['kind'] == 'completed', trace['outcome']
            failures += audit(trace['events'])
            dispatches += sum(item['kind'] == 'host_request_started' and item.get('qualified_action') == 'Command.run' for item in trace['events'])
        statuses = [json.loads(line.split('[STATUS ] ', 1)[1]) for text in (output, restored)
                    for line in text.splitlines() if '[STATUS ] ' in line]
        assert len(statuses) == 2 and all(item['pending'] == '' for item in statuses), statuses
        runs = [json.loads(line.split('[RUN    ] ', 1)[1]) for line in restored.splitlines() if '[RUN    ] {' in line]
        assert len(runs) == 8 and all(item['phase'] == 'completed' for item in runs), runs
        assert state.stat().st_mode & 0o777 == 0o700
        assert all(path.parent.stat().st_mode & 0o777 == 0o700 for path in trace_paths)
        assert dispatches == 5
        result = {'functional_status': 'passed', 'scope': 'prepared-index Git tools and launcher; not the full workflow gate',
            'model_http_requests': 7, 'native_command_dispatches': dispatches, 'native_approvals': approvals,
            'restore_commands': 0, 'restore_approvals': restore_approvals, 'status': statuses, 'runs': runs,
            'traces': [str(path) for path in trace_paths], 'approval_audit': failures}
        (evidence / 'functional.json').write_text(json.dumps(result, indent=2))
        print('FUNCTIONAL PASS native Git, private launcher and new-process restore: ' + str(evidence), flush=True)
        assert not failures, 'upstream Command approval provenance audit failed (#102); see functional.json'
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
