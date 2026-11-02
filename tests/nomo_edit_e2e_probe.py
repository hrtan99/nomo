#!/usr/bin/env python3
"""One owned private-workspace edit through the actual user launcher and PTY."""
import argparse
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--scenario', choices=('applied', 'denied', 'changed', 'checkfail', 'state_immutable', 'checktimeout', 'cancel_preview', 'cancel_check'), default='applied')
    args = parser.parse_args()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='edit-entry-e2e-', dir=args.evidence_dir))
    workspace, state = out / 'workspace', out / 'state'
    workspace.mkdir(mode=0o700)
    state.mkdir(mode=0o700)
    (workspace / 'note.txt').write_text('before old\n')
    os.chmod(workspace / 'note.txt', 0o600)
    check = ('echo tamper > /state/edit.sqlite3' if args.scenario == 'state_immutable' else
             'exit 7' if args.scenario == 'checkfail' else
             'sleep 80' if args.scenario == 'checktimeout' else
             'touch check-started; sleep 80' if args.scenario == 'cancel_check' else
             'test "$(cat note.txt)" = "before new"')
    command = [str(ROOT / 'scripts/nomo-read.sh'), 'edit', '--root', str(workspace), '--state', str(state),
               '--id', 'owned-edit', '--path', 'note.txt', '--target', 'old', '--replacement', 'new',
               '--check', '/bin/sh', '-c', check]
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    settings[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    gates = set()
    result = {'status': 'failed', 'scope': 'one synthetic private-workspace edit'}
    try:
        deadline = time.monotonic() + 100
        while proc.poll() is None:
            if time.monotonic() >= deadline:
                raise TimeoutError('launcher did not finish')
            ready, _, _ = select.select([master], [], [], .1)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b''
                output.extend(chunk)
            if b'Type `yes` to approve:' in output and 'native' not in gates:
                gates.add('native')
                os.write(master, b'yes\n')
            if b'CONFIRM Apply this exact preview? [y/N]' in output and 'application' not in gates:
                gates.add('application')
                if args.scenario == 'changed':
                    (workspace / 'note.txt').write_text('external change\n')
                if args.scenario == 'cancel_preview':
                    proc.send_signal(signal.SIGTERM)
                else:
                    os.write(master, b'no\n' if args.scenario == 'denied' else b'yes\n')
            if args.scenario == 'cancel_check' and (workspace / 'check-started').exists() and 'cancelled' not in gates:
                gates.add('cancelled')
                proc.send_signal(signal.SIGTERM)
        while select.select([master], [], [], 0)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
        result.update(exit=proc.returncode, gates=sorted(gates), file=(workspace / 'note.txt').read_text())
        assert gates == ({'native', 'application', 'cancelled'} if args.scenario == 'cancel_check' else {'native', 'application'})
        assert b'PREVIEW ' in output and b'DIFF ' in output
        if args.scenario == 'applied':
            assert proc.returncode == 0
            assert b'INTENT durable owned-edit' in output and b'APPLIED owned-edit' in output
            assert result['file'] == 'before new\n' and b'Check passed.' in output
        elif args.scenario == 'cancel_preview':
            assert proc.returncode in (125, 143) and b'INTENT durable owned-edit' not in output
            assert b'Running the requested check' not in output and result['file'] == 'before old\n'
        elif args.scenario == 'cancel_check':
            assert proc.returncode in (125, 143) and b'APPLIED owned-edit' in output
            assert ('Check failed or could not be completed (exit ' + str(proc.returncode) + ').').encode() in output
            assert result['file'] == 'before new\n'
        elif args.scenario == 'state_immutable':
            assert proc.returncode != 0 and b'APPLIED owned-edit' in output
            assert b'Check failed or could not be completed' in output
            assert result['file'] == 'before new\n'
            import sqlite3
            with sqlite3.connect('file:' + str(state / 'edit.sqlite3') + '?mode=ro', uri=True) as db:
                assert db.execute('SELECT count(*) FROM memory_entries').fetchone()[0] == 1
        elif args.scenario == 'checktimeout':
            assert proc.returncode == 124 and b'APPLIED owned-edit' in output
            assert b'Check failed or could not be completed (exit 124).' in output
            assert result['file'] == 'before new\n'
        elif args.scenario == 'checkfail':
            assert proc.returncode == 7 and b'APPLIED owned-edit' in output
            assert b'Check failed or could not be completed (exit 7).' in output
            assert result['file'] == 'before new\n'
        elif args.scenario == 'denied':
            assert b'Running the requested check' not in output
            assert proc.returncode != 0 and b'APPLIED owned-edit' not in output
            assert b'INTENT durable owned-edit' not in output and result['file'] == 'before old\n'
        else:
            assert b'Running the requested check' not in output
            assert proc.returncode != 0 and b'INTENT durable owned-edit' in output
            assert b'APPLIED owned-edit' not in output and result['file'] == 'external change\n'
        if args.scenario in ('cancel_preview', 'cancel_check'):
            result['cleanup_status'] = 'unconfirmed' if proc.returncode == 125 else 'helper-confirmed'
            if proc.returncode == 125:
                assert b'Terminal cleanup is unconfirmed' in output
        listing = subprocess.run(['docker','ps','-aq','--filter','label=nomo.terminal.invocation'], capture_output=True, text=True, timeout=5, check=True)
        for identifier in listing.stdout.split():
            inspected = subprocess.run(['docker','inspect','--format','{{json .Mounts}}',identifier], capture_output=True, text=True, timeout=5)
            if inspected.returncode != 0:
                assert 'No such' in inspected.stderr
                continue
            mounts = {item['Destination']: item for item in json.loads(inspected.stdout)}
            selected = mounts.get('/edit-fixture', {}).get('Source')
            assert selected not in (str(workspace), '/host_mnt' + str(workspace)), 'owned edit container still exists'
        result['matching_container_absent'] = True
        result['status'] = 'passed'
    except BaseException as error:
        result['failure_type'] = type(error).__name__
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=3)
        os.close(master)
        (out / 'output.bin').write_bytes(output)
        (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status':result['status'], 'evidence':str(out)}))
    return 0 if result['status'] == 'passed' else 1

if __name__ == '__main__':
    raise SystemExit(main())
