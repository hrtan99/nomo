"""Interrupt a real export approval, restore its attempt and export explicitly."""
from pathlib import Path
import json
import os
import tempfile

from native_recovery_probe import audit
from native_worker_probe import Client

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = 'Existing export target · 鹈鹕\n'
NOTE = 'Inspected cancelled.json: original contents remain. Close this unresolved attempt; do not replay it.'


def runs(text):
    return [json.loads(line.split('[RUN    ] ', 1)[1]) for line in text.splitlines() if line.startswith('[RUN    ] {')]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-export-recovery-')).resolve()
    project = evidence / 'project'
    project.mkdir(mode=0o700)
    (project / 'cancelled.json').write_text(ORIGINAL)
    environment = dict(os.environ, MINIMAX_API_KEY='unused-no-model', NOMO_NATIVE_STATE=str(evidence / 'state'),
                       NOMO_NATIVE_TRACE_ROOT=str(evidence / 'traces'))
    command = [str(ROOT / 'scripts/nomo-native'), str(project)]
    print('EVIDENCE ' + str(evidence), flush=True)
    first = Client(command + ['--new'], environment, evidence, 'interrupted')
    first.send('/rename Export recovery')
    assert 'Existing export target' in first.send('/read cancelled.json')
    pending = first.pending_approval('/export cancelled.json')
    preview = json.loads(next(line.split('[EXPORT ] ', 1)[1] for line in pending.splitlines() if '[EXPORT ] ' in line))
    assert preview['path'] == 'cancelled.json'
    assert json.loads(preview['content'])['session']['title'] == 'Export recovery'
    os.write(first.master, b'\x03')
    first.collect(prompt=False, approve=False)
    interrupted_code = first.process.wait(timeout=10)
    os.close(first.master)
    assert interrupted_code == 130, first.output.decode()
    assert (project / 'cancelled.json').read_text() == ORIGINAL

    exported = []
    def approve(output):
        value = json.loads(next(line.split('[EXPORT ] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[EXPORT ] ' in line))
        assert value['path'] == 'accepted.json', value
        package = json.loads(value['content'])
        assert package['format'] == 'nomo-native-conversation-1' and package['session']['id'] == 'native-0'
        assert package['session']['title'] == 'Export recovery'
        assert any(NOTE in item['text'] for item in package['events']), package
        metadata = json.loads(package['session']['metadata'])
        assert len(metadata['attempts']) == 1 and metadata['attempts'][0]['phase'] == 'closed_unknown', metadata
        exported.append(value['content'])
    restored = Client(command + ['--resume', 'native-0'], environment, evidence, 'restored', approver=approve)
    before = runs(restored.send('/runs'))
    assert len(before) == 1 and before[0]['kind'] == 'export' and before[0]['phase'] == 'dispatching', before
    assert 'Existing export target' in restored.send('/read cancelled.json')
    closed = restored.send('/resolve-run ' + before[0]['id'] + ' ' + NOTE)
    assert 'closed_unknown' in closed
    assert '[EXPORTED] accepted.json' in restored.send('/export accepted.json')
    assert len(exported) == 1 and (project / 'accepted.json').read_text() == exported[0]
    after = runs(restored.send('/runs'))
    assert {value['phase'] for value in after} == {'closed_unknown', 'completed'}, after
    completed = next(value for value in after if value['phase'] == 'completed')
    assert completed['kind'] == 'export' and completed['result_event'] >= 0
    restored.send('/import accepted.json')
    assert not runs(restored.send('/runs'))
    assert NOTE in restored.send('/history')
    restored.leave()
    assert restored.approvals == 1 and (project / 'cancelled.json').read_text() == ORIGINAL
    traces = [Path(next(line.split('[TRACE  ] ', 1)[1] for line in text.splitlines() if '[TRACE  ] ' in line)) / 'trace.json'
              for text in (first.output.decode(), restored.output.decode())]
    data = [json.loads(path.read_text()) for path in traces]
    assert data[0]['outcome']['kind'] != 'completed' and data[1]['outcome']['kind'] == 'completed'
    assert all(not audit(trace['events']) for trace in data)
    boundaries = [[item for item in trace['events'] if item['kind'] == 'host_request_started'] for trace in data]
    assert not any(item.get('qualified_action') == 'Fs.atomic_replace' for item in boundaries[0])
    assert sum(item.get('qualified_action') == 'Fs.atomic_replace' for item in boundaries[1]) == 1
    assert all(not any(item.get('qualified_action', '').startswith(('Command.', 'Agentic.')) for item in part) for part in boundaries)
    result = {'status': 'passed', 'scope': 'real export approval interruption, fresh-Host unknown-outcome resolution without replay, explicitly approved new export, and imported metadata remaining historical',
        'interrupted_exit_code': interrupted_code, 'unresolved_attempt': before[0], 'final_attempts': after,
        'native_write_approvals': restored.approvals, 'model_http_requests': 0, 'command_dispatches': 0,
        'exported_path': str(project / 'accepted.json'), 'traces': [str(path) for path in traces],
        'outcomes': [trace['outcome']['kind'] for trace in data],
        'limitations': ['This covers interruption before write approval, not every post-write finalization window.']}
    (evidence / 'functional.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS native export interruption and explicit recovery: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
