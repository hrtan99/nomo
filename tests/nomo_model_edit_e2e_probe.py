#!/usr/bin/env python3
"""Exercise the model-edit launcher against an owned synthetic HTTP model."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
TOKEN = 'NOMO_SYNTHETIC_MODEL_EDIT_ONLY'

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        try:
            length = int(self.headers['Content-Length'])
            assert 0 < length <= 131072 and self.path == '/v1/chat/completions'
            assert self.headers.get('Authorization') == 'Bearer ' + TOKEN
            request = json.loads(self.rfile.read(length))
            context = json.loads(request['messages'][1]['content'])
            phase = ['plan', 'child', 'aggregate'][len(self.server.phases)]
            assert context['phase'] == phase and context['path'] == 'note.txt'
            assert context['request'] == 'change old to new' and context['before'] == 'before old\n'
            if phase == 'plan': text = '["delegate","change old to new"]'
            elif phase == 'child':
                assert context['task'] == 'change old to new'
                text = '["edit","missing","new"]' if self.server.scenario == 'invalid' else '["edit","old","new"]'
            else:
                assert context['completed'] is True and context['after'] == 'before new\n'
                if self.server.scenario == 'aggregate_failure':
                    self.server.phases.append(phase)
                    self.send_error(500)
                    return
                text = 'Edit completed.'
            self.server.phases.append(phase)
            body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                               'usage': {'prompt_tokens': 10, 'completion_tokens': 4, 'total_tokens': 14}}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception:
            self.server.failed = True
            self.send_error(500)

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--scenario', choices=('applied', 'denied', 'invalid', 'aggregate_failure'), default='applied')
    args = parser.parse_args(); args.evidence_dir.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='model-edit-', dir=args.evidence_dir))
    workspace, state = out/'workspace', out/'state'
    workspace.mkdir(mode=0o700); state.mkdir(mode=0o700)
    (workspace/'note.txt').write_text('before old\n'); (workspace/'note.txt').chmod(0o600)
    server = HTTPServer(('127.0.0.1', 0), Fake); server.phases = []; server.failed = False; server.scenario = args.scenario
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    env = os.environ.copy(); env.update(NOMO_READ_MODEL_BASE_URL='http://host.docker.internal:%d/v1' % server.server_port,
                                         NOMO_QWEN_SERVER_API_KEY=TOKEN)
    cmd = [str(ROOT/'scripts/nomo-read.sh'), 'edit', '--root', str(workspace), '--state', str(state),
           '--id', 'owned-edit', '--path', 'note.txt', '--once', 'change old to new',
           '--check', '/bin/sh', '-c', 'test "$(cat note.txt)" = "before new"']
    master, slave = pty.openpty(); settings = termios.tcgetattr(slave)
    settings[3] &= ~(termios.ECHO | termios.ECHONL); termios.tcsetattr(slave, termios.TCSANOW, settings)
    proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave); output = bytearray(); gates = set(); result = {'status': 'failed', 'scope': 'synthetic model edit'}
    try:
        deadline = time.monotonic()+100
        while proc.poll() is None:
            if time.monotonic() >= deadline: raise TimeoutError('model edit timeout')
            if select.select([master], [], [], .1)[0]:
                try: output.extend(os.read(master, 65536))
                except OSError: pass
            if b'Type `yes` to approve:' in output and 'native' not in gates:
                gates.add('native'); os.write(master, b'yes\n')
            if b'CONFIRM Apply this exact preview? [y/N]' in output and 'application' not in gates:
                gates.add('application'); os.write(master, b'no\n' if args.scenario == 'denied' else b'yes\n')
        while select.select([master], [], [], 0)[0]:
            try: chunk = os.read(master, 65536)
            except OSError: break
            if not chunk: break
            output.extend(chunk)
        result.update(exit=proc.returncode, phases=server.phases, gates=sorted(gates), file=(workspace/'note.txt').read_text())
        assert not server.failed
        if args.scenario == 'applied':
            assert proc.returncode == 0 and server.phases == ['plan', 'child', 'aggregate']
            assert gates == {'native', 'application'} and result['file'] == 'before new\n'
            assert b'APPLIED owned-edit' in output and b'FINAL ' in output and b'Check passed.' in output
        elif args.scenario == 'aggregate_failure':
            assert proc.returncode != 0 and server.phases == ['plan', 'child', 'aggregate']
            assert gates == {'native', 'application'} and result['file'] == 'before new\n'
            assert b'APPLIED owned-edit' in output and b'Running the requested check' not in output
            assert b'launcher did not classify the cause' in output
            assert b'remote outcome may be unknown' in output and b'Inspect the file and edit status' in output
            import hashlib
            def state_digest():
                return {str(p.relative_to(state)): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in state.rglob('*') if p.is_file()}
            before_state = state_digest()
            standalone = subprocess.run([str(ROOT/'scripts/nomo-read.sh'), 'check', '--root', str(workspace),
                                         '--', '/bin/sh', '-c', 'test "$(cat note.txt)" = "before new"'],
                                        stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=90)
            (out/'standalone-check.stdout').write_bytes(standalone.stdout)
            (out/'standalone-check.stderr').write_bytes(standalone.stderr)
            assert standalone.returncode == 0 and b'Check passed.' in standalone.stdout
            assert state_digest() == before_state and (workspace/'note.txt').read_text() == 'before new\n'
            result['standalone_check_exit'] = standalone.returncode
            result['state_bytes_unchanged_by_check'] = True
        else:
            assert proc.returncode != 0 and server.phases == ['plan', 'child'] and result['file'] == 'before old\n'
            assert b'APPLIED owned-edit' not in output and b'Running the requested check' not in output
            assert gates == ({'native', 'application'} if args.scenario == 'denied' else set())
        listing = subprocess.run(['docker', 'ps', '-aq', '--filter', 'label=nomo.terminal.invocation'],
                                 capture_output=True, text=True, timeout=5, check=True)
        for identifier in listing.stdout.split():
            inspected = subprocess.run(['docker', 'inspect', '--format', '{{json .Mounts}}', identifier],
                                       capture_output=True, text=True, timeout=5)
            if inspected.returncode:
                assert 'No such' in inspected.stderr
                continue
            mounts = {item['Destination']: item for item in json.loads(inspected.stdout)}
            assert mounts.get('/edit-fixture', {}).get('Source') not in (str(workspace), '/host_mnt'+str(workspace))
        result['matching_container_absent'] = True
        result['status'] = 'passed'
    except BaseException as error:
        result['failure_type'] = type(error).__name__
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=20)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=3)
        os.close(master); server.shutdown(); server.server_close(); thread.join(timeout=5)
        (out/'output.bin').write_bytes(output); (out/'result.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({'status': result['status'], 'evidence': str(out)}))
    return 0 if result['status'] == 'passed' else 1
if __name__ == '__main__': raise SystemExit(main())
