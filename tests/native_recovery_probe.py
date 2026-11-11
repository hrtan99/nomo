"""Interrupt a published native file change, then recover in a new process."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import os
import pty
import select
import subprocess
import tempfile
import threading

from native_mutations_probe import ROOT, Model, BINARY, approve_preview


def terminal(command, environment, turns, project, interrupt=False, approve=approve_preview, prompts=(b'nomo> ',)):
    master, slave = pty.openpty()
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output, sent, approvals, stopped = bytearray(), 0, 0, False
    try:
        while True:
            ready, _, _ = select.select([master], [], [], 1)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                if sent < len(turns) and sum(output.count(prompt) for prompt in prompts) > sent:
                    os.write(master, (turns[sent] + '\n').encode())
                    sent += 1
                if not stopped and output.count(b'Type `yes` to approve:') > approvals:
                    if interrupt and (project / 'new/sub/index.html').exists():
                        last = next(line for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line)
                        pending = json.loads(last.split('[COMMAND] ', 1)[1])
                        assert pending['program'] == '/bin/cp' and pending['arguments'][2] == 'new/sub/index.html', pending
                        os.write(master, b'\x03')
                        stopped = True
                    else:
                        approve(output)
                        os.write(master, b'yes\n')
                        approvals += 1
            elif process.poll() is not None:
                break
        code = process.wait()
    finally:
        os.close(master)
    return code, output.decode(), approvals, stopped


def audit(events):
    approval, failures = None, []
    for event in events:
        if event['kind'] == 'host_request_started' and event.get('qualified_action') == 'Approval.request':
            approval = event
        elif event['kind'] == 'host_request_started' and (event.get('qualified_action', '').startswith('Command.') or event.get('qualified_action') == 'Fs.atomic_replace'):
            if approval is None or event['authority']['approval_count'] != approval['authority']['approval_count'] + 1:
                failures.append({'request': event['id'], 'action': event['qualified_action'],
                                 'authority': event['authority'], 'approval': approval['id'] if approval else None})
            approval = None
    return failures


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-recovery-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    (project / 'note.txt').write_text('before old\n')
    (project / 'move.bin').write_bytes(BINARY)
    (project / 'delete-dir').mkdir()
    (project / 'delete-dir/program').write_bytes(BINARY)
    (project / 'delete-dir/program').chmod(0o751)
    server = ThreadingHTTPServer(('0.0.0.0', 0), Model)
    server.requests, server.evidence, server.project = [], evidence, project
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-local-only',
        NOMO_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1', NOMO_MODEL_ALLOW_PRIVATE='true',
        NOMO_NATIVE_WORKSPACE=str(project), NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_EVIDENCE=str(traces))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0131-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=true', 'dev',
        '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
        '--allow-effects', '--trace-out', '/native-evidence/trace.json', '--args', '--workspace', str(project)]
    print('EVIDENCE ' + str(evidence), flush=True)
    try:
        code, output, approvals, interrupted = terminal(command, environment,
            ['Apply the related synthetic file changes with native undo.'], project, interrupt=True)
        (evidence / 'interrupted-terminal.txt').write_text(output)
        assert interrupted and code != 0, output
        assert (project / 'new/sub/index.html').read_text() == '<h1>Pelican</h1>\n'
        assert len(server.requests) == 1
        request = next(line for line in output.splitlines() if '[COMMAND] ' in line)
        backup = json.loads(request.split('[COMMAND] ', 1)[1])['arguments'][2]
        edit = backup.rsplit('/', 1)[1]
        restored = list(command)
        restored[restored.index('/native-evidence/trace.json')] = '/native-evidence/recovered.json'
        code, recovered, recovery_approvals, _ = terminal(restored, environment,
            ['/edits', '/read new/sub/index.html', '/rollback ' + edit, '/edits', '/status', '/quit'], project)
        (evidence / 'recovered-terminal.txt').write_text(recovered)
        assert code == 0, recovered
        assert '[PENDING]' in recovered and '"phase":"applying"' in recovered and '"phase":"rolled_back"' in recovered
        assert not (project / 'new').exists() and not (project / 'extra').exists()
        assert (project / 'note.txt').read_text() == 'before old\n'
        assert (project / 'move.bin').read_bytes() == BINARY and (project / 'delete-dir/program').read_bytes() == BINARY
        assert len(server.requests) == 1
        status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in recovered.splitlines() if '[STATUS ] ' in line))
        assert status['pending'] == '' and status['ledger']['tools'] == 2, status
        first = json.loads((traces / 'trace.json').read_text())
        final = json.loads((traces / 'recovered.json').read_text())
        assert final['outcome']['kind'] == 'completed'
        failures = audit(first['events']) + audit(final['events'])
        (evidence / 'functional.json').write_text(json.dumps({'functional_result': 'passed', 'model_requests': 1,
            'edit': edit, 'first_outcome': first['outcome']['kind'], 'recovered_outcome': final['outcome']['kind'],
            'approvals_before_interrupt': approvals, 'approvals_for_recovery': recovery_approvals,
            'status': status, 'approval_audit': failures}, indent=2))
        print('FUNCTIONAL PASS native interrupt + new-process rollback: ' + str(evidence), flush=True)
        assert not failures, 'upstream Command Host approval snapshot audit failed; see functional.json'
        print('PASS native interrupt, recovery and approval audit: ' + str(evidence))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
