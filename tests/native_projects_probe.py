"""Native project selection retains each folder's Etas Host and live jobs."""
from pathlib import Path
import json
import os
import tempfile

from native_recovery_probe import audit
from native_worker_probe import Client, ECHO, TEXT, execution_pid

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-projects-')).resolve()
    first, second = evidence / 'first project', evidence / 'second 鹈鹕'
    for path, text in ((first, 'first marker\n'), (second, 'second marker\n')):
        path.mkdir(mode=0o700)
        (path / 'marker.txt').write_text(text)
    env = dict(os.environ, MINIMAX_API_KEY='unused-no-model-requests', NOMO_NATIVE_STATE=str(evidence / 'state'),
               NOMO_NATIVE_TRACE_ROOT=str(evidence / 'traces'))
    command = [str(ROOT / 'scripts/nomo-native'), str(first)]
    expected = [str(second), str(first), str(second)]
    observed = []
    job = None
    def approve(output):
        line = next(line for line in reversed(output.decode().splitlines()) if '[OPEN   ] ' in line or '[PROCESS] ' in line)
        if '[OPEN   ] ' in line:
            selected = json.loads(line.split('[OPEN   ] ', 1)[1])
            assert selected == expected[len(observed)], selected
            observed.append(selected)
        else:
            preview = json.loads(line.split('[PROCESS] ', 1)[1])
            if preview['operation'] == 'start':
                assert preview['program'] == '/usr/bin/python3' and preview['arguments'] == ECHO, preview
            else:
                assert preview['job'] == job and preview['operation'] in ('reconnect', 'read', 'write', 'close_stdin'), preview
                if preview['operation'] == 'write': assert preview['input'] == TEXT, preview
    print('EVIDENCE ' + str(evidence), flush=True)
    client = Client(command + ['--new'], env, evidence, 'terminal', approver=approve)
    first_worker = next(line.split('[WORKER ] ', 1)[1] for line in client.output.decode().splitlines() if '[WORKER ] ' in line)
    first_pid, first_top = execution_pid(first_worker)
    (evidence / 'first-process-before-switch.txt').write_text(first_top)
    client.send('/rename First project')
    assert 'first marker' in client.send('/read marker.txt')
    started = client.send('/spawn ' + json.dumps(['/usr/bin/python3', *ECHO]))
    job = json.loads(next(line.split('[JOB    ] ', 1)[1] for line in started.splitlines() if '[JOB    ] ' in line))['id']
    assert 'ready\\n' in client.send('/poll ' + job + ' 4096')
    switched = client.switch(str(second), second)
    second_worker = next(line.split('[WORKER ] ', 1)[1] for line in switched.splitlines() if '[WORKER ] ' in line)
    second_pid, second_top = execution_pid(second_worker)
    (evidence / 'second-process-before-return.txt').write_text(second_top)
    client.send('/rename Second project')
    assert 'second marker' in client.send('/read marker.txt')
    assert str(first) in client.send('/projects')
    returned = client.switch('2', first)
    assert first_worker in returned and 'second marker' not in returned, returned
    returned_pid, returned_top = execution_pid(first_worker)
    (evidence / 'first-process-after-return.txt').write_text(returned_top)
    assert first_pid == returned_pid
    assert 'native-0 · First project' in client.send('/sessions')
    client.send('/send ' + job + ' ' + json.dumps(TEXT))
    assert 'echo:鹈鹕 café\\n' in client.send('/poll ' + job + ' 4096')
    client.send('/close-input ' + job)
    assert '"phase":"exited"' in client.send('/poll ' + job + ' 4096')
    assert 'echo:鹈鹕 café\\n' in client.send('/job-output ' + job)
    client.leave()
    output = client.output.decode()

    # A new startup chooser attaches the already-running B endpoint. Replayed
    # terminal prompts never trigger automatic task input or approval answers.
    reopened = Client(command + ['--open'], env, evidence, 'reopened-terminal', approver=approve,
                      prompts=(b'nomo> ', b'project> '))
    selector = next(line.split(' ', 2)[1] for line in reopened.output.decode().splitlines()
                    if line.startswith('[PROJECT] ') and line.endswith(str(second)))
    selected = reopened.switch(selector, second, startup=True)
    assert second_worker in selected, selected
    final_pid, final_top = execution_pid(second_worker)
    (evidence / 'second-process-after-reopen.txt').write_text(final_top)
    assert second_pid == final_pid
    status_text = reopened.send('/status')
    status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in status_text.splitlines() if '[STATUS ] ' in line))
    assert 'second marker' in reopened.send('/history')
    reopened.leave()
    assert status['id'] == 'native-1' and status['workspace'] == str(second) and status['ledger']['turns'] == 0, status
    traces = [Path(line.split('[TRACE  ] ', 1)[1]) / 'trace.json' for text in (output, reopened.output.decode()) for line in text.splitlines() if '[TRACE  ] ' in line]
    assert len(traces) == 5 and len(set(traces)) == 3, traces
    commands, control_writes = 0, 0
    for path in set(traces):
        trace = json.loads(path.read_text())
        assert trace['outcome']['kind'] == 'completed' and not audit(trace['events']), path
        boundaries = [item for item in trace['events'] if item['kind'] == 'host_request_started']
        commands += sum(item.get('qualified_action', '').startswith('Command.') for item in boundaries)
        control_writes += sum(item.get('qualified_action', '') == 'Fs.atomic_replace' for item in boundaries)
        assert not any(item.get('qualified_action', '').startswith('Agentic.') for item in boundaries)
    assert commands == 11 and control_writes == 3 and client.approvals + reopened.approvals == 14
    assert (first / 'marker.txt').read_text() == 'first marker\n' and (second / 'marker.txt').read_text() == 'second marker\n'
    result = {'functional_status': 'passed', 'model_http_requests': 0, 'native_command_dispatches': commands,
        'native_control_write_approvals': control_writes, 'native_approvals': client.approvals + reopened.approvals,
        'actual_host_invocations': len(set(traces)), 'project_attachments': len(traces),
        'first_worker': first_worker, 'second_worker': second_worker, 'first_etas_pid': first_pid, 'second_etas_pid': second_pid,
        'selected_paths': observed, 'restored_status': status, 'traces': [str(path) for path in dict.fromkeys(traces)],
        'scope': 'Etas-owned project selection, same-Host project return and original live job Unicode I/O/EOF, separate histories, startup chooser reattaching another retained Host'}
    (evidence / 'functional.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('PASS native project switching with retained Hosts and live jobs: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
