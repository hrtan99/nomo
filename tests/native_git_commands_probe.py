"""Native /git command parsing, actual staged diff/commit and approval audit."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

from native_recovery_probe import terminal, audit

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-git-commands-')).resolve()
    project = evidence / 'project'
    project.mkdir(mode=0o700)
    def git(*arguments):
        return subprocess.run(['git', '-C', str(project), *arguments], check=True, capture_output=True, text=True).stdout
    (project / 'note.txt').write_text('before old\n')
    for args in (['init', '--initial-branch=main'], ['config', 'user.name', 'Synthetic Fixture'],
                 ['config', 'user.email', 'fixture@example.invalid'], ['config', 'commit.gpgsign', 'false'],
                 ['add', 'note.txt'], ['commit', '-m', 'Initial synthetic fixture']):
        git(*args)
    (project / 'note.txt').write_text('before new\n')
    git('add', 'note.txt')
    env = dict(os.environ, MINIMAX_API_KEY='unused-no-model-requests', NOMO_NATIVE_STATE=str(evidence / 'state'),
               NOMO_NATIVE_TRACE_ROOT=str(evidence / 'traces'))
    argv = [
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch'],
        ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--cached', '--', 'note.txt'],
        ['add', '--', 'note.txt'], ['commit', '-m', 'Native CLI commit'],
        ['--no-optional-locks', 'log', '--oneline', '-n', '1'], ['--no-optional-locks', 'branch', '--list'],
    ]
    reviewed = []
    def approve(output):
        value = json.loads(next(line.split('[COMMAND] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line))
        assert value == {'program': '/usr/bin/git', 'arguments': argv[len(reviewed)]}, value
        reviewed.append(value)
    print('EVIDENCE ' + str(evidence), flush=True)
    code, output, approvals, _ = terminal([str(ROOT / 'scripts/nomo-native'), str(project), '--new'], env,
        ['/git status', '/git diff --staged ["note.txt"]', '/git commit {"message":"Native CLI commit","paths":["note.txt"]}',
         '/git log 1', '/git branches', '/status', '/runs', '/quit'], project, approve=approve)
    (evidence / 'terminal.txt').write_text(output)
    assert code == 0 and approvals == 6, output
    results = [json.loads(line.split('[GIT    ] ', 1)[1]) for line in output.splitlines() if '[GIT    ] ' in line]
    assert len(results) == 5 and all(item['exit_code'] == 0 for item in results), results
    assert '-before old' in results[1]['stdout'] and '+before new' in results[1]['stdout'], results
    assert 'Native CLI commit' in results[2]['stdout'] and 'Native CLI commit' in results[3]['stdout']
    assert results[4]['stdout'] == '* main\n'
    assert git('status', '--porcelain') == '' and git('rev-list', '--count', 'HEAD').strip() == '2'
    trace_path = Path(next(line.split('[TRACE  ] ', 1)[1] for line in output.splitlines() if '[TRACE  ] ' in line)) / 'trace.json'
    trace = json.loads(trace_path.read_text())
    assert trace['outcome']['kind'] == 'completed' and not audit(trace['events'])
    assert not any(item.get('qualified_action', '').startswith('Agentic.') for item in trace['events'])
    status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in output.splitlines() if '[STATUS ] ' in line))
    assert status['pending'] == '' and status['ledger']['turns'] == 0 and status['ledger']['tools'] == 6
    (evidence / 'functional.json').write_text(json.dumps({'status': 'passed', 'model_http_requests': 0, 'native_approvals': approvals,
        'native_commands': 6, 'status_record': status, 'results': results, 'trace': str(trace_path)}, indent=2))
    print('PASS native Git commands, actual commit and strict approvals: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
