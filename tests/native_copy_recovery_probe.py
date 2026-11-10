"""Interrupt a native import, resume its sealed source, fork and reopen; no model."""
from pathlib import Path
import hashlib
import json
import os
import pty
import re
import select
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def interrupt_import(command, environment):
    master, slave = pty.openpty()
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output, sent, stopped = bytearray(), False, False
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
                if not sent and b'nomo> ' in output:
                    os.write(master, b'/import history.json\n')
                    sent = True
                if not stopped and b'[COPY   ] native-1 1/300' in output:
                    assert process.poll() is None
                    os.write(master, b'\x03')
                    stopped = True
            elif process.poll() is not None:
                break
        code = process.wait()
    finally:
        os.close(master)
    assert stopped and code != 0, output.decode()
    assert b'[SESSION] native-1' not in output, output.decode()
    return code, output.decode()


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-copy-recovery-')).resolve()
    project, state, traces = (evidence / name for name in ('project', 'state', 'native'))
    for directory in (project, state, traces):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)
    packet = {'format': 'nomo-native-conversation-1',
              'session': {'id': 'original', 'workspace': 'synthetic', 'title': 'Sealed original', 'metadata': '{}'},
              'events': [{'id': str(index), 'role': 'user' if index == 0 else 'assistant', 'name': '',
                          'text': 'Original objective.' if index == 0 else f'synthetic event {index}'}
                         for index in range(300)]}
    raw = json.dumps(packet)
    (project / 'history.json').write_text(raw)
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-unused', NOMO_NATIVE_WORKSPACE=str(project),
                       NOMO_NATIVE_STATE=str(state), NOMO_NATIVE_EVIDENCE=str(traces))
    base = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0121-official-compose.yaml', 'config/local-tryout-compose.yaml',
                 'config/etas-runtime-cache-compose.yaml', 'config/nomo-native-compose.yaml'):
        base += ['--file', str(ROOT / name)]

    def command(tty, trace):
        return base + ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=' + str(tty).lower(), 'dev',
                       '/home/nomo/.cargo/bin/etas', 'run', '/workspace', '--flow', 'native_project', '--profile', 'nomo-native',
                       '--allow-effects', '--trace-out', '/native-evidence/' + trace, '--args', '--workspace', str(project)]

    print('EVIDENCE ' + str(evidence), flush=True)
    code, interrupted = interrupt_import(command(True, 'interrupted.json'), environment)
    (evidence / 'interrupted-terminal.txt').write_text(interrupted)
    # The importer must now use its saved original package, not reread this path.
    (project / 'history.json').rename(project / 'kept-source.json')
    resumed = subprocess.run(command(False, 'resumed.json'), cwd=ROOT, env=environment,
        input='/copies\n/status\n/resume-copy native-1\n/status\n/fork 3\n/status\n/copies\n/quit\n',
        capture_output=True, text=True)
    (evidence / 'resumed-stdout.txt').write_text(resumed.stdout)
    (evidence / 'resumed-stderr.txt').write_text(resumed.stderr)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    statuses = [json.loads(line.split('[STATUS ] ', 1)[1]) for line in resumed.stdout.splitlines() if '[STATUS ] ' in line]
    assert [item['id'] for item in statuses] == ['native-0', 'native-1', 'native-2'], statuses
    assert statuses[0]['next_event'] == 0 and statuses[1]['next_event'] == 301 and statuses[2]['next_event'] == 5
    assert statuses[1]['first_user'] == 1 and statuses[2]['first_user'] == 2
    assert all(item['pending'] == '' and item['ledger']['tools'] == 0 for item in statuses)
    jobs = [json.loads(line.split('[COPY   ] ', 1)[1]) for line in resumed.stdout.splitlines()
            if '[COPY   ] {' in line]
    interrupted_job = next(item for item in jobs if item['id'] == 'native-1' and item['phase'] == 'copying')
    assert 0 < interrupted_job['cursor'] < 300, interrupted_job
    assert interrupted_job['digest'] == list(hashlib.sha256(raw.encode()).digest())
    assert any(item['id'] == 'native-1' and item['phase'] == 'ready' and item['cursor'] == 300 for item in jobs)
    assert any(item['id'] == 'native-2' and item['phase'] == 'ready' and item['cursor'] == 4 for item in jobs)
    restored = subprocess.run(command(False, 'restored.json'), cwd=ROOT, env=environment,
        input='/status\n/resume native-1\n/history\n/quit\n', capture_output=True, text=True)
    (evidence / 'restored-stdout.txt').write_text(restored.stdout)
    (evidence / 'restored-stderr.txt').write_text(restored.stderr)
    assert restored.returncode == 0, restored.stdout + restored.stderr
    assert '"id":"native-2"' in restored.stdout and '[assistant/ #300] synthetic event 299' in restored.stdout
    archived = next(line.split('[archive/imported_source #0] ', 1)[1] for line in restored.stdout.splitlines()
                    if '[archive/imported_source #0] ' in line)
    assert archived == raw and (project / 'kept-source.json').read_text() == raw
    copied = [match.groups() for line in restored.stdout.splitlines()
              if (match := re.fullmatch(r'(?:nomo> )?\[(user|assistant)/ #(\d+)\] (.*)', line))]
    assert copied == [(item['role'], str(index + 1), item['text']) for index, item in enumerate(packet['events'])]
    outcomes = {}
    for name in ('interrupted', 'resumed', 'restored'):
        trace = json.loads((traces / (name + '.json')).read_text())
        outcomes[name] = trace['outcome']['kind']
        assert not any(item.get('request_kind') == 'model' for item in trace['events'])
        assert not any(item.get('qualified_action') in ('Command.run', 'Fs.atomic_replace') for item in trace['events'])
    assert outcomes['resumed'] == outcomes['restored'] == 'completed'
    (evidence / 'result.json').write_text(json.dumps({'status': 'passed', 'interrupted_exit': code,
        'interrupted_copy': interrupted_job, 'statuses': statuses, 'trace_outcomes': outcomes,
        'original_sha256': hashlib.sha256(raw.encode()).hexdigest(), 'model_requests': 0}, indent=2))
    print('PASS native import interruption, sealed-source resume, fork and new-process restoration: ' + str(evidence))


if __name__ == '__main__':
    main()
