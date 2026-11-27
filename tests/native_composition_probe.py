"""Positive native composition and readonly dispatch through the selected ports."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-composition-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-unused',
                       NOMO_MODEL_BASE_URL='http://127.0.0.1:9/v1', NOMO_MODEL_ALLOW_PRIVATE='true',
                       NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_STATE=str(state),
                       NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0246-official-compose.yaml',
                 'config/local-tryout-compose.yaml', 'config/etas-runtime-cache-compose.yaml',
                 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project',
                '--profile', 'nomo-native', '--allow-effects', '--trace-out', '/native-evidence/trace.json',
                '--args', '--workspace', str(project)]
    commands = '/projects\n/edits\n/copies\n/jobs\n/status\n/quit\n'
    print('EVIDENCE ' + str(evidence), flush=True)
    result = subprocess.run(command, cwd=ROOT, env=environment, input=commands,
                            capture_output=True, text=True)
    (evidence / 'stdout.txt').write_text(result.stdout)
    (evidence / 'stderr.txt').write_text(result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    assert '[PROJECT] 1 ' + str(project) in result.stdout
    assert result.stdout.count('nomo> ') == 6, result.stdout
    status = json.loads(next(line.split('[STATUS ] ', 1)[1]
                             for line in result.stdout.splitlines() if '[STATUS ] ' in line))
    assert status['id'] == 'native-0' and status['pending'] == ''
    assert status['next_event'] == 0 and status['ledger']['turns'] == 0
    trace = json.loads((traces / 'trace.json').read_text())
    assert trace['outcome']['kind'] == 'completed' and not trace.get('incomplete', False)
    assert trace['termination']['local_work_settled'] is True
    starts = [event for event in trace['events'] if event['kind'] == 'host_request_started']
    ends = [event for event in trace['events'] if event['kind'] == 'host_request_finished']
    assert {event['id'] for event in starts} == {event['id'] for event in ends}
    assert all(event['outcome']['kind'] == 'succeeded' for event in ends)
    assert not any(event.get('request_kind') == 'model' or
                   event.get('qualified_action') == 'Agentic.step' for event in starts)
    (evidence / 'result.json').write_text(json.dumps({
        'status': 'passed', 'host_requests': len(starts), 'model_requests': 0,
        'commands': commands.splitlines(),
        'scope': 'Construction and readonly project/mutation/copy/job dispatch; '
                 'does not accept live process operations, transfers or default cutover.',
    }, indent=2) + '\n')
    print('PASS native composition and readonly dispatch: ' + str(evidence))


if __name__ == '__main__':
    main()
