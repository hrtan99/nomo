"""Native history selection, search, paging and fork; no model requests."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-history-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    packet = {'format': 'nomo-native-conversation-1',
              'session': {'id': 'original', 'workspace': 'synthetic', 'title': 'Saved original', 'metadata': '{}'},
              'events': [{'id': str(number), 'role': 'user' if number == 0 else 'assistant',
                          'name': '', 'text': 'Original migration objective.' if number == 0 else f'synthetic event {number}'}
                         for number in range(55)]}
    (project / 'history.json').write_text(json.dumps(packet))
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-unused',
                       NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0120-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
                '--allow-effects', '--trace-out', '/native-evidence/trace.json', '--args', '--workspace', str(project)]
    commands = '/import history.json\n/page 1\n/history synthetic event 54\n/fork 3\n/history\n/status\n/sessions\n/quit\n'
    print('EVIDENCE ' + str(evidence), flush=True)
    result = subprocess.run(command, cwd=ROOT, env=environment, input=commands, capture_output=True, text=True)
    (evidence / 'stdout.txt').write_text(result.stdout)
    (evidence / 'stderr.txt').write_text(result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    pages = result.stdout.split('[HISTORY] More events remain; /page 51', 1)[0]
    assert '[assistant/ #50] synthetic event 49' in pages
    assert '[assistant/ #51] synthetic event 50' not in pages
    searched, branch = result.stdout.split('[SESSION] native-2 · Saved original (fork)', 1)
    assert '[assistant/ #55] synthetic event 54' in searched
    assert 'Original migration objective.' in branch and 'synthetic event 2' in branch
    branch_assistants = [line.split('] ', 1)[1] for line in branch.splitlines() if line.startswith('[assistant/ #')]
    assert branch_assistants == ['synthetic event 1', 'synthetic event 2'], branch_assistants
    status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in branch.splitlines() if '[STATUS ] ' in line))
    assert status['id'] == 'native-2' and status['first_user'] == 2 and status['pending'] == ''
    assert status['ledger']['turns'] == 0
    trace = json.loads((traces / 'trace.json').read_text())
    assert trace['outcome']['kind'] == 'completed'
    assert not any(event.get('request_kind') == 'model' for event in trace['events'])
    print('PASS native history commands: ' + str(evidence))


if __name__ == '__main__':
    main()
