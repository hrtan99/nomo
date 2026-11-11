"""A new terminal client controls live jobs in the same resident Etas Host."""
from pathlib import Path
import json
import os
import pty
import select
import subprocess
import tempfile
import time

from native_recovery_probe import audit, terminal

ROOT = Path(__file__).resolve().parents[1]
ECHO = ['-u', '-c', "import sys; print('ready',flush=True)\nfor line in sys.stdin: print('echo:'+line.rstrip('\\n'),flush=True)"]
SLEEP = ['-u', '-c', "import time; print('sleeping',flush=True); time.sleep(300)"]
TEXT = '鹈鹕 café\n'


def execution_pid(worker):
    text = subprocess.check_output(['docker', 'top', worker, '-eo', 'pid,args'], text=True)
    matches = [fields for line in text.splitlines()[1:] if (fields := line.split(maxsplit=1))
               and fields[1].startswith('/home/nomo/.cargo/bin/etas run /workspace')]
    assert len(matches) == 1, text
    return int(matches[0][0]), text


class Client:
    def __init__(self, command, environment, evidence, name):
        self.master, slave = pty.openpty()
        self.process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        self.output = bytearray()
        self.jobs = []
        self.path = evidence / (name + '.txt')
        self.collect(prompt=True, approve=False)
        # Attach replays previous terminal bytes. Drain the replay before any
        # input; only subsequent, fresh approval prompts may be answered.
        while select.select([self.master], [], [], 0.2)[0]:
            self.output.extend(os.read(self.master, 65536))
        self.save()

    def save(self):
        self.path.write_bytes(self.output)

    def collect(self, prompt, approve=True):
        start, approvals = len(self.output), 0
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.output.extend(chunk)
                fresh = self.output[start:]
                if approve and fresh.count(b'Type `yes` to approve:') > approvals:
                    preview = json.loads(next(line.split('[PROCESS] ', 1)[1] for line in reversed(fresh.decode().splitlines()) if '[PROCESS] ' in line))
                    if preview['operation'] == 'start':
                        assert preview['program'] == '/usr/bin/python3' and preview['arguments'] in (ECHO, SLEEP), preview
                    else:
                        assert preview['job'] in self.jobs, preview
                        assert preview['operation'] in ('reconnect', 'read', 'write', 'close_stdin', 'stop'), preview
                        if preview['operation'] == 'write':
                            assert preview['input'] == TEXT, preview
                    os.write(self.master, b'yes\n')
                    approvals += 1
                if prompt and b'nomo> ' in fresh:
                    self.save()
                    return fresh.decode()
            elif self.process.poll() is not None:
                break
        self.save()
        if prompt:
            raise AssertionError('Native prompt not reached; inspect ' + str(self.path))
        return self.output[start:].decode()

    def send(self, text):
        os.write(self.master, (text + '\n').encode())
        return self.collect(prompt=True)

    def leave(self, detach=False):
        os.write(self.master, b'\x10\x11' if detach else b'/quit\n')
        self.collect(prompt=False)
        code = self.process.wait(timeout=10)
        os.close(self.master)
        assert code == 0, self.output.decode()


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-worker-')).resolve()
    project = evidence / 'project'
    project.mkdir(mode=0o700)
    environment = dict(os.environ, MINIMAX_API_KEY='unused-no-model', NOMO_NATIVE_STATE=str(evidence / 'state'),
                       NOMO_NATIVE_TRACE_ROOT=str(evidence / 'traces'))
    command = [str(ROOT / 'scripts/nomo-native'), str(project)]
    print('EVIDENCE ' + str(evidence), flush=True)
    first = Client(command + ['--new'], environment, evidence, 'first-client')
    worker = next(line.split('[WORKER ] ', 1)[1] for line in first.output.decode().splitlines() if '[WORKER ] ' in line)
    first.send('/rename Resident native conversation')
    started = first.send('/spawn ' + json.dumps(['/usr/bin/python3', *ECHO]))
    echo_job = json.loads(next(line.split('[JOB    ] ', 1)[1] for line in started.splitlines() if '[JOB    ] ' in line))['id']
    first.jobs.append(echo_job)
    assert 'ready\\n' in first.send('/poll ' + echo_job + ' 4096')
    started = first.send('/spawn ' + json.dumps(['/usr/bin/python3', *SLEEP]))
    sleep_job = json.loads(next(line.split('[JOB    ] ', 1)[1] for line in started.splitlines() if '[JOB    ] ' in line))['id']
    first.jobs.append(sleep_job)
    assert 'sleeping\\n' in first.send('/poll ' + sleep_job + ' 4096')
    before = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .State}}', worker], text=True))
    first_pid, first_top = execution_pid(worker)
    (evidence / 'processes-before-detach.txt').write_text(first_top)
    first.leave(detach=True)
    detached = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .State}}', worker], text=True))
    assert detached['Running'] and detached['Pid'] == before['Pid'] and detached['StartedAt'] == before['StartedAt'], detached
    second_pid, second_top = execution_pid(worker)
    (evidence / 'processes-after-detach.txt').write_text(second_top)
    assert first_pid == second_pid
    second = Client(command, environment, evidence, 'second-client')
    second.jobs = first.jobs
    assert worker in second.output.decode()
    assert 'Resident native conversation' in second.send('/sessions')
    second.send('/send ' + echo_job + ' ' + json.dumps(TEXT))
    echo = second.send('/poll ' + echo_job + ' 4096')
    assert 'echo:鹈鹕 café\\n' in echo, echo
    second.send('/close-input ' + echo_job)
    assert '"phase":"exited"' in second.send('/poll ' + echo_job + ' 4096')
    assert '"phase":"stopped"' in second.send('/stop ' + sleep_job)
    archive = second.send('/job-output ' + echo_job)
    assert 'echo:鹈鹕 café\\n' in archive, archive
    second.leave()
    trace_directory = Path(next(line.split('[TRACE  ] ', 1)[1] for line in first.output.decode().splitlines() if '[TRACE  ] ' in line))
    trace = json.loads((trace_directory / 'trace.json').read_text())
    assert trace['outcome']['kind'] == 'completed' and not audit(trace['events'])
    commands = [item for item in trace['events'] if item['kind'] == 'host_request_started' and item.get('qualified_action', '').startswith('Command.')]
    assert len(commands) == 16, len(commands)
    assert not any(item.get('qualified_action', '').startswith('Agentic.') for item in trace['events'])
    code, restored, approvals, _ = terminal(command + ['--resume', 'native-0'], environment,
        ['/sessions', '/jobs', '/job-output ' + echo_job, '/quit'], project)
    (evidence / 'fresh-host.txt').write_text(restored)
    assert code == 0 and approvals == 0 and 'Resident native conversation' in restored and 'echo:鹈鹕 café\\n' in restored, restored
    result = {'status': 'passed', 'scope': 'terminal client detach/reconnect to the same native Host; live Unicode input/output, EOF and stop; fresh-Host archive restore',
        'worker': worker, 'same_container_init_pid': before['Pid'], 'same_etas_pid': first_pid,
        'started_at': before['StartedAt'], 'native_command_operations': len(commands),
        'model_http_requests': 0, 'approval_audit': [], 'trace': str(trace_directory / 'trace.json'),
        'limitations': ['Explicit /quit ends the Host; use the terminal detach keys to retain it.', 'No PTY is provided to native command children.', 'Host or container crash recovery of live jobs is not established.']}
    (evidence / 'functional.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS resident Etas native worker: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
