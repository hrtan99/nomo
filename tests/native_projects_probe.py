"""Native project selection, actual root remounts and conversation restoration."""
from pathlib import Path
import json
import os
import tempfile

from native_recovery_probe import terminal, audit

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
    def approve(output):
        selected = json.loads(next(line.split('[OPEN   ] ', 1)[1] for line in reversed(output.decode().splitlines()) if '[OPEN   ] ' in line))
        assert selected == expected[len(observed)], selected
        observed.append(selected)
    print('EVIDENCE ' + str(evidence), flush=True)
    code, output, approvals, _ = terminal(command + ['--new'], env,
        ['/rename First project', '/read marker.txt', '/open ' + str(second), '/rename Second project', '/read marker.txt',
         '/projects', '/open 2', '/history', '/sessions', '/projects', '/quit'], first, approve=approve)
    (evidence / 'terminal.txt').write_text(output)
    assert code == 0 and approvals == 2, output
    assert '[SESSION] native-1' in output and '[SESSION] native-0 · First project' in output, output
    assert 'first marker' in output and 'second marker' in output
    restored_first = output.rsplit('[PROJECT] ' + str(first), 1)[-1]
    assert 'first marker' in restored_first and 'second marker' not in restored_first, restored_first
    code, reopened, more_approvals, _ = terminal(command + ['--open'], env,
        ['2', '/status', '/history', '/quit'], first, approve=approve, prompts=(b'nomo> ', b'project> '))
    (evidence / 'reopened-terminal.txt').write_text(reopened)
    assert code == 0 and more_approvals == 1, reopened
    assert '[SESSION] native-1 · Second project' in reopened and 'second marker' in reopened
    status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in reopened.splitlines() if '[STATUS ] ' in line))
    assert status['id'] == 'native-1' and status['workspace'] == str(second) and status['ledger']['turns'] == 0, status
    traces = [Path(line.split('[TRACE  ] ', 1)[1]) / 'trace.json' for text in (output, reopened) for line in text.splitlines() if '[TRACE  ] ' in line]
    assert len(traces) == 5 and len(set(traces)) == 5
    for path in traces:
        trace = json.loads(path.read_text())
        assert trace['outcome']['kind'] == 'completed' and not audit(trace['events']), path
        assert not any(item.get('qualified_action', '').startswith(('Command.', 'Agentic.')) for item in trace['events'])
    assert (first / 'marker.txt').read_text() == 'first marker\n' and (second / 'marker.txt').read_text() == 'second marker\n'
    result = {'functional_status': 'passed', 'model_http_requests': 0, 'native_command_dispatches': 0,
        'native_control_write_approvals': approvals + more_approvals, 'actual_host_invocations': len(traces),
        'selected_paths': observed, 'restored_status': status, 'traces': [str(path) for path in traces],
        'scope': 'Etas-owned recent projects and selection, environment-only remount, distinct conversations and startup chooser'}
    (evidence / 'functional.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('PASS native project selection, remount and saved conversation restore: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
