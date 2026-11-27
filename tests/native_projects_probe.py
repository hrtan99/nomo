"""Native project selection retains each folder's Etas Host and live jobs."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

from native_recovery_probe import audit, terminal
from native_worker_probe import Client, ECHO, TEXT, execution_pid

ROOT = Path(__file__).resolve().parents[1]


def selected(text):
    return json.loads(next(line.split('[STATUS ] ', 1)[1] for line in reversed(text.splitlines()) if '[STATUS ] {' in line))


def startup_routing(evidence, env, first, second, expected, approve, original):
    command = [str(ROOT / 'scripts/nomo-native'), str(first)]
    print('PHASE startup session routing', flush=True)
    other = Client([str(ROOT / 'scripts/nomo-native'), str(second), '--id', original['id']], env, evidence,
                   'startup-second', approver=approve)
    second_worker = next(line.split('[WORKER ] ', 1)[1] for line in other.output.decode().splitlines() if '[WORKER ] ' in line)
    second_pid, _ = execution_pid(second_worker)
    other.leave(detach=True)

    fresh = Client(command + ['--new', '--title', 'Additional A'], env, evidence, 'startup-first', approver=approve)
    first_worker = next(line.split('[WORKER ] ', 1)[1] for line in fresh.output.decode().splitlines() if '[WORKER ] ' in line)
    first_pid, _ = execution_pid(first_worker)
    fresh.leave(detach=True)
    idle = Client(command, env, evidence, 'startup-idle', approver=approve)
    assert first_worker in idle.output.decode() and execution_pid(first_worker)[0] == first_pid
    additional = selected(idle.send('/status'))
    assert additional['id'] == 'native-2' and additional['title'] == 'Additional A'
    idle.leave(detach=True)

    # Selection is recorded by a separate native flow; attachment sends no command.
    exact = Client(command + ['--id', 'native-0', '--title', 'Resumed A'], env, evidence, 'startup-exact', approver=approve)
    assert first_worker in exact.output.decode() and execution_pid(first_worker)[0] == first_pid
    resumed = selected(exact.send('/status'))
    assert resumed['id'] == 'native-0' and resumed['title'] == 'Resumed A'
    assert exact.approvals == 0
    exact.leave(detach=True)

    chooser = Client(command + ['--resume', '--all'], env, evidence, 'startup-all', approver=approve,
                     prompts=(b'Conversation number or ID',))
    listing = chooser.output.decode()
    assert str(first) in listing and str(second) in listing and additional['id'] in listing
    row = next(line for line in listing.splitlines() if line.startswith('[SESSION] ') and ' · ' + original['id'] + ' · ' in line)
    choice = row.split('[SESSION] ', 1)[1].split(' · ', 1)[0]
    expected.append(str(second))
    chooser.prompts = (b'nomo> ',)
    routed = chooser.switch(choice, second, startup=True)
    assert second_worker in routed and execution_pid(second_worker)[0] == second_pid
    assert selected(chooser.send('/status'))['id'] == original['id']
    assert chooser.approvals == 1
    chooser.leave()

    # A foreign ID can be inspected without borrowing the resident terminal.
    inspected = subprocess.run(command + ['--id', original['id'], '--status'], cwd=ROOT, env=env,
                               capture_output=True, text=True)
    (evidence / 'startup-foreign-status.txt').write_text(inspected.stdout + inspected.stderr)
    assert inspected.returncode == 0, inspected.stdout + inspected.stderr
    foreign = selected(inspected.stdout)
    assert foreign['id'] == original['id'] and foreign['workspace'] == str(second)
    assert execution_pid(first_worker)[0] == first_pid

    # Keep all startup fields when --open changes the mounted project.
    expected.append(str(second))
    code, output, approvals, _ = terminal(command + ['--open', str(second), '--new', '--title', 'Forwarded startup', '--status'],
                                         env, [], first, approve=approve)
    (evidence / 'startup-forwarded.txt').write_text(output)
    assert code == 0 and approvals == 1, output
    forwarded = selected(output)
    assert forwarded['workspace'] == str(second) and forwarded['id'] == 'native-3'
    assert forwarded['title'] == 'Forwarded startup' and forwarded['next_event'] == 0

    final = Client(command, env, evidence, 'startup-final', approver=approve)
    assert first_worker in final.output.decode() and execution_pid(first_worker)[0] == first_pid
    assert selected(final.send('/status'))['id'] == 'native-0'
    final.leave()
    traces = [path for path in (evidence / 'traces').glob('run-*/trace.json')]
    total_commands = total_controls = 0
    for path in traces:
        trace = json.loads(path.read_text())
        assert trace['outcome']['kind'] == 'completed' and trace['termination']['local_work_settled']
        assert not audit(trace['events']), path
        starts = [event for event in trace['events'] if event['kind'] == 'host_request_started']
        ends = [event for event in trace['events'] if event['kind'] == 'host_request_finished']
        assert len(starts) == len(ends) and {event['id'] for event in starts} == {event['id'] for event in ends}
        assert all(event['outcome']['kind'] == 'succeeded' for event in ends)
        assert not any(event.get('request_kind') == 'model' for event in starts)
        total_commands += sum(event.get('qualified_action', '').startswith('Command.') for event in starts)
        total_controls += sum(event.get('qualified_action') == 'Fs.atomic_replace' for event in starts)
    assert total_commands == 11 and total_controls == 5
    return {'status': 'passed', 'first_worker': first_worker, 'first_etas_pid': first_pid,
            'second_worker': second_worker, 'second_etas_pid': second_pid, 'additional': additional,
            'resumed': resumed, 'foreign_status': foreign, 'forwarded': forwarded,
            'native_command_actions_including_original_case': total_commands,
            'native_control_actions_including_original_case': total_controls, 'traces': len(traces),
            'scope': 'Same-Host exact startup selection, global chooser to a retained foreign Host, isolated foreign-ID inspection, '
                     'and --open preserving new/title/status. No startup command or consent is sent to resident stdin.'}


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
    (evidence / 'retained-project-functional.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    result['startup_routing'] = startup_routing(evidence, env, first, second, expected, approve, status)
    (evidence / 'functional.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('PASS native project switching with retained Hosts and live jobs: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
