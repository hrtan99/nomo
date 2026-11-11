"""Full product requirement: reconnect a background job after leaving Nomo.

No model requests. Uses the actual native launcher and CLI commands; a failed
fresh-Host reconnect remains a failed acceptance rather than a passing fallback.
"""
from pathlib import Path
import json
import os
import tempfile

from native_recovery_probe import terminal, audit
from native_process_probe import ECHO

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-reconnect-')).resolve()
    project = evidence / 'project'
    project.mkdir(mode=0o700)
    env = dict(os.environ, MINIMAX_API_KEY='unused-no-model-requests', NOMO_NATIVE_STATE=str(evidence / 'state'),
               NOMO_NATIVE_TRACE_ROOT=str(evidence / 'traces'))
    command = [str(ROOT / 'scripts/nomo-native'), str(project)]
    def approve(output):
        value = json.loads(next(line.split('[PROCESS] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[PROCESS] ' in line))
        if value['operation'] == 'start':
            assert value == {'operation': 'start', 'program': '/usr/bin/python3', 'arguments': ECHO}, value
        else:
            saved = json.loads(next(line.split('[JOB    ] ', 1)[1] for line in output.decode().splitlines() if '[JOB    ] ' in line))
            assert value['job'] == saved['id'] and value['handle'] == saved['handle'], value
            assert value['operation'] in ('reconnect', 'read'), value
            if value['operation'] == 'read': assert value['max_bytes'] == 4096, value
    print('EVIDENCE ' + str(evidence), flush=True)
    first_code, output, approvals, _ = terminal(command + ['--new'], env,
        ['/spawn ' + json.dumps(['/usr/bin/python3', *ECHO]), '/poll native-0-job-0 4096', '/jobs', '/quit'], project, approve=approve)
    (evidence / 'terminal.txt').write_text(output)
    assert first_code == 0 and approvals == 3, output
    code, restored, new_approvals, _ = terminal(command + ['--resume', 'native-0'], env,
        ['/jobs', '/poll native-0-job-0 4096', '/quit'], project, approve=approve)
    (evidence / 'restored-terminal.txt').write_text(restored)
    trace_paths = [Path(next(line.split('[TRACE  ] ', 1)[1] for line in text.splitlines() if '[TRACE  ] ' in line)) / 'trace.json' for text in (output, restored)]
    traces = [json.loads(path.read_text()) for path in trace_paths]
    assert not [failure for trace in traces for failure in audit(trace['events'])]
    assert all(not any(item.get('qualified_action', '').startswith('Agentic.') for item in trace['events']) for trace in traces)
    result = {'functional_status': 'passed' if code == 0 else 'failed', 'scope': 'fresh-process live background-job reconnection',
        'first_exit_code': first_code, 'restore_exit_code': code, 'native_approvals': approvals + new_approvals,
        'model_http_requests': 0, 'traces': [str(path) for path in trace_paths], 'outcomes': [trace['outcome']['kind'] for trace in traces],
        'native_error': 'background command is not available for reconnection' if 'background command is not available for reconnection' in restored else ''}
    (evidence / 'functional.json').write_text(json.dumps(result, indent=2))
    assert code == 0, 'Fresh-process live job reconnect not accepted; see ' + str(evidence / 'functional.json')
    print('PASS native live job reconnect after restart: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
