#!/usr/bin/env python3
"""One explicitly selected TERMINAL-002 case through the actual host launcher.

Root owns execution. This driver supplies the existing scripted HTTP fixture,
observes exact owned processes/containers and persists a shared no-refund ledger.
It never retries, replays a work ID, starts a third turn, or stops other resources.
"""
import argparse
from copy import deepcopy
import errno
import fcntl
import hashlib
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import socket
import stat
import subprocess
import tempfile
import termios
import threading
import time
import tomllib
import traceback
import uuid

import local_tryout_probe as trial

ROOT, chain = trial.ROOT, trial.chain
OWNER_LABEL = 'nomo.terminal.invocation'
TOKEN = 'terminal002-scripted-synthetic-token'
NATIVE_PROMPT = b'Type '+bytes([96])+b'yes'+bytes([96])+b' to approve:'
REQUEST_PROMPT = b'REQUEST /help /show /exit'
BOUNDS = {
    'B1': dict(lifetimes=0, logical=0, atomic=0),
    'B2': dict(lifetimes=1, logical=7, atomic=0),
    'B3': dict(lifetimes=1, logical=14, atomic=2),
    'B4': dict(lifetimes=1, logical=7, atomic=0),
    'B5': dict(lifetimes=1, logical=7, atomic=1),
}
ORIGINAL_REPLY = chain.reply
ORIGINAL_CONTAINER = trial.active_container


def save(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n')


def ledger_update(path, change):
    # The batch ledger already exists and is jointly owned with A; never reset it.
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r+', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        info = os.fstat(stream.fileno())
        assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'ledger must be one regular file'
        value = json.load(stream); preserved = {key:deepcopy(item) for key,item in value.items() if key != 'B'}
        bounds = value['B']
        assert (bounds['max_lifetimes'], bounds['max_logical'], bounds['max_atomic'], bounds['max_correction_retests'], bounds['conservative_fixture_ceiling']) == (6, 63, 7, 2, 567)
        change(bounds)
        assert {key:item for key,item in value.items() if key != 'B'} == preserved, 'A and prior ledgers must remain unchanged'
        stream.seek(0); stream.truncate(); json.dump(value, stream, indent=2); stream.write('\n')
        stream.flush(); os.fsync(stream.fileno())
        return value


def reserve(path, case, evidence, correction):
    identity = uuid.uuid4().hex
    def change(value):
        cases = value.setdefault('cases', {})
        attempts = [item for selected in cases.values() for item in selected]
        previous = cases.get(case, [])
        assert not any(item['status'] in ['reserved', 'running'] for item in attempts), 'serial case already reserved; no automatic reuse'
        assert not previous or (len(previous) == 1 and previous[0]['status'] == 'failed' and correction), 'repeat requires one failed case and a concrete TL-reviewed correction'
        assert not correction or previous, 'correction must name the failed case'
        assert value['correction_retests']+bool(correction) <= value['max_correction_retests'], 'two batch corrections exhausted'
        assert value['lifetimes']+BOUNDS[case]['lifetimes'] <= value['max_lifetimes'], 'lifetime allowance exhausted'
        for key, limit in [('logical','max_logical'), ('atomic','max_atomic')]:
            assert sum(item['reserved'][key] for item in attempts)+BOUNDS[case][key] <= value[limit], key+' reserved ceiling exhausted'
        assert value['logical_inferences'] <= value['max_logical'] and value['atomic_writes'] <= value['max_atomic']
        assert max(value['native_requests'], value['HTTP_attempts']) <= value['conservative_fixture_ceiling']
        value['lifetimes'] += BOUNDS[case]['lifetimes']
        value['correction_retests'] += int(bool(correction))
        cases.setdefault(case, []).append(dict(id=identity, case=case, evidence=str(evidence), reserved=BOUNDS[case],
            correction_review=correction, status='reserved', observations=None))
    ledger_update(path, change)
    return identity


def finish_ledger(path, identity, record):
    def change(value):
        selected = next(item for attempts in value['cases'].values() for item in attempts if item['id'] == identity)
        assert selected['status'] == 'reserved', 'attempt observations already charged'
        counts = record.get('counts') or {}
        selected.update(status=record['status'], observations=counts, failure=record.get('failure'),
                        qualifications=record.get('qualifications', []))
        # Partial traces contribute only starts actually present, never a fabricated total.
        lower = record.get('partial_trace_observed_starts', {})
        for key, source in [('logical_inferences','logical_inference_starts'),
                            ('HTTP_attempts','HTTP_attempts'), ('atomic_writes','atomic_replace_starts')]:
            observed = counts.get(source)
            value[key] += observed if observed is not None else lower.get(source, 0)
        native_starts = counts.get('native_model_action_starts')
        # Effective HTTP attempts=1 makes each received wire request a native-request lower bound.
        wire = counts.get('HTTP_attempts')
        native_lower = max(native_starts if native_starts is not None else lower.get('native_model_action_starts',0), wire if wire is not None else lower.get('HTTP_attempts',0))
        value['native_requests'] += native_lower
        selected['native_requests_observed_lower_bound'] = native_lower
        if not counts.get('trace_complete', False) or not counts.get('logical_exact_proven', False):
            value.setdefault('unproven_counts', []).append(dict(id=identity, case=record['case'],
                qualification='B counters include known trace starts/HTTP observations only; missing/partial trace or failed stage/HTTP proof leaves the affected exact logical/native/atomic totals unproven. Reserved ceilings are retained without refund.'))
    ledger_update(path, change)


def docker(arguments):
    return subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=10)


def inspected(identifier):
    fields = '{"id":{{json .Id}},"name":{{json .Name}},"token":{{json (index .Config.Labels "'+OWNER_LABEL+'")}},"running":{{json .State.Running}}}'
    result = docker(['inspect', '--format', fields, identifier])
    if result.returncode:
        if 'No such object:' in result.stderr or 'No such container:' in result.stderr:
            return None
        raise AssertionError('read-only exact container inspection unavailable')
    value = json.loads(result.stdout); owner = value['token']
    assert isinstance(owner, str) and re.fullmatch('[0-9a-f]{32}', owner) and value['name'] == '/nomo-terminal-'+owner
    assert re.fullmatch('[0-9a-f]{64}', value['id']) and isinstance(value['running'], bool)
    return dict(id=value['id'], name=value['name'][1:], token=owner, running=value['running'])


def source_facts():
    manifest = tomllib.loads((ROOT/'etas.toml').read_text())
    profiles = manifest['runtime']['profiles']; original = profiles['work-chain']
    expected = deepcopy(original); expected['approval']['mode'] = 'deny'
    assert profiles['work-chain-once'] == expected and original['approval']['mode'] == 'prompt'
    assert original['model']['retry'] == dict(attempts=1, delay_ms=0)
    overlay = (ROOT/'config/local-tryout-model-compose.yaml').read_text()
    assert 'http://host.docker.internal:18095/v1' in overlay
    paths = ['etas.toml', 'etas.lock', 'scripts/local-tryout.sh', 'scripts/terminal-transport.py',
             'src/nomo/cli/terminal_args.es', 'src/nomo/entry/terminal_entry.es',
             'src/nomo/entry/work_chain_entry.es', 'config/local-tryout-model-compose.yaml']
    return dict(model=original['model']['model'], HTTP_attempts_per_native_request=1,
                endpoint='http://host.docker.internal:18095/v1', approval=dict(TTY='prompt', nonTTY='deny'),
                hashes={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in paths},
                qualification='Source configuration only; actual trace and HTTP observations are retained separately. No real Qwen endpoint or key is used.')


class TrackedHTTPServer(ThreadingHTTPServer):
    """Track transport lifetime while retaining the accepted HTTP handler."""
    daemon_threads = True
    block_on_close = False

    def __init__(self, address):
        self.handler_lock = threading.Lock()
        self.handlers = []
        super().__init__(address, trial.CoLocatedHandler)
        self.socket.settimeout(0.5)

    def process_request(self, request, address):
        request.settimeout(3.0)  # Bound socket/header/body inactivity and response writes.
        entry = dict(socket=request, thread=None, done=threading.Event(), errors=[])
        def handle():
            try:
                super(TrackedHTTPServer, self).process_request_thread(request, address)
            finally:
                entry['done'].set()
        thread = threading.Thread(target=handle, daemon=True)
        entry['thread'] = thread
        with self.handler_lock:
            self.handlers.append(entry)
        try:
            thread.start()
        except BaseException:
            with self.handler_lock:
                entry['errors'].append(traceback.format_exc())
            self.shutdown_request(request); entry['done'].set()
            raise

    def handle_error(self, request, address):
        with self.handler_lock:
            entry = next(item for item in self.handlers if item['socket'] is request)
            entry['errors'].append(traceback.format_exc())

    def settled(self):
        with self.handler_lock:
            return all(item['done'].is_set() and not item['thread'].is_alive() and not item['errors'] for item in self.handlers)

    def abort_sockets(self):
        with self.handler_lock:
            pending = [item['socket'] for item in self.handlers if not item['done'].is_set()]
        for connection in pending:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

    def joined(self, deadline):
        with self.handler_lock:
            entries = list(self.handlers)
        for item in entries:
            thread = item['thread']
            if thread.ident is not None:
                thread.join(timeout=max(0.0, deadline-time.monotonic()))
        return self.settled()


class Driver:
    def __init__(self, case, folder, directory, record):
        self.case, self.folder, self.directory, self.record = case, folder, directory, record
        self.process = self.server = self.thread = None
        self.master = None; self.out = b''; self.err = b''
        self.owner = self.client = None
        self.gate = threading.Event(); self.held = threading.Event(); self.release_ok = False
        self.all_requests = []; self.completed_turns = []
        self.sent_signal_at = None; self.next_owner_poll = 0
        self.selected = trial.item(1, case == 'B2')
        self.selected['calls'] = dict(B1=0, B2=6, B3=7, B4=1, B5=7)[case]
        self.binding, self.preview = chain.work.edit.expected(self.selected)
        self.current_native = self.current_nomo = self.current_request = False
        self.segment_out = self.segment_err = 0
        self.milestones = []; self.held_resources = None

    def discover(self):
        if self.client is None and self.process is not None and self.process.poll() is None:
            observed = subprocess.run(['ps', '-ww', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True, check=True, timeout=5)
            for line in observed.stdout.splitlines():
                fields = line.strip().split(None, 2)
                if len(fields) != 3 or int(fields[1]) != self.process.pid:
                    continue
                args = shlex.split(fields[2])
                if '--name' not in args or '--label' not in args:
                    continue
                name = args[args.index('--name')+1]; label = args[args.index('--label')+1]
                token = name.removeprefix('nomo-terminal-')
                if re.fullmatch('[0-9a-f]{32}', token) and label == OWNER_LABEL+'='+token:
                    self.client = dict(pid=int(fields[0]), parent_pid=int(fields[1]), command=fields[2])
                    self.owner = dict(name=name, token=token, id=None)
        if self.owner is not None:
            value = inspected(self.owner['name'])
            if value is not None:
                assert value['token'] == self.owner['token'] and (self.owner.get('id') in [None, value['id']])
                self.owner = value

    def writer_container(self):
        self.discover()
        assert self.owner and self.owner.get('id'), 'exact live writer container not observed'
        current = inspected(self.owner['id'])
        assert current and current['running'] and current['token'] == self.owner['token'], 'writer container not live/owned'
        return current['id']

    def live_rows(self):
        trial._REQUEST_READ.active = True
        try:
            return chain.rows(self.directory/'state')
        finally:
            trial._REQUEST_READ.active = False

    def start_server(self):
        self.server = TrackedHTTPServer(('127.0.0.1', trial.PORT))
        self.server.item, self.server.state = self.selected, self.directory/'state'
        self.server.records, self.server.lock, self.server.partial = [], threading.Lock(), None
        gate_ordinal = {'B4':0, 'B5':6}.get(self.case)
        def reply(selected, context, ordinal):
            assert ordinal < self.server.item['calls'], 'unexpected extra HTTP/native request; case must stop'
            if ordinal == gate_ordinal:
                request = self.server.records[ordinal]
                expected = selected['before'] if self.case == 'B4' else selected['after']
                assert (self.directory/'workspace'/trial.TARGET).read_bytes() == expected.encode()
                request['held_before_response'] = True
                self.held_resources = trial.resources()
                self.held.set()
                assert self.gate.wait(40) and self.release_ok, 'held response aborted; no valid continuation supplied'
            return ORIGINAL_REPLY(selected, context, ordinal)
        chain.reply = reply
        trial.active_container = self.writer_container
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs=dict(poll_interval=0.01), daemon=True)
        self.thread.start()

    def commands(self):
        args = ['new', '--id', trial.ROOT_ID, '--child-id', trial.CHILD_ID,
                '--workspace', trial.WORKSPACE, '--path', trial.TARGET, '--allow', trial.CONTEXT]
        if self.case == 'B2':
            args += ['--once', trial.FIRST]
        return [str(trial.LAUNCH), 'terminal', str(self.directory), *args]

    def terminate(self, number):
        if self.process is not None and self.process.poll() is None and self.sent_signal_at is None:
            self.sent_signal_at = time.monotonic()
            self.record['signal'] = dict(number=number, name=signal.Signals(number).name,
                                         target='only the top-level owned launcher Popen PID', pid=self.process.pid)
            self.process.send_signal(number)

    def observe_error(self):
        if self.server:
            with self.server.lock:
                requests = list(self.server.records)
            assert len(requests) <= self.server.item['calls'], 'extra HTTP request observed'
            for request in requests:
                assert 'observer_error' not in request, request.get('observer_error')
            with self.server.handler_lock:
                assert not any(item['errors'] for item in self.server.handlers), 'HTTP handler transport error'
                connections = len(self.server.handlers)
            if self.server.settled():
                assert connections == len(self.all_requests)+len(requests), 'HTTP connection ended without a complete recorded request'

    def next_turn(self):
        first = self.server.item
        with self.server.lock:
            requests = list(self.server.records)
        assert len(requests) == 7 and all(item['finished'].is_set() for item in requests) and self.server.settled()
        chain.assert_http(first, requests, self.binding, [])
        rows = self.live_rows(); parent = rows[chain.CHAIN]['turn:1']
        chain.assert_record(first, parent['value'], 'summary-confirmed', self.binding)
        assert (self.directory/'workspace'/trial.TARGET).read_bytes() == first['after'].encode()
        assert self.server.partial is not None and self.server.partial['version'] != parent['version']
        self.record['first_parent'] = deepcopy(parent)
        with self.server.lock:
            assert self.server.records == requests and all(item['finished'].is_set() for item in requests) and self.server.settled(), 'first HTTP turn changed or remains active; no reset'
            self.completed_turns.append(dict(item=first, binding=self.binding, prior=[], requests=list(requests)))
            self.all_requests.extend(requests)
            self.selected = trial.item(2); self.binding, self.preview = chain.work.edit.expected(self.selected)
            self.server.item, self.server.records, self.server.partial = self.selected, [], None
        self.segment_out, self.segment_err = len(self.out), len(self.err)
        self.current_native = self.current_nomo = False; self.current_request = True
        self.milestones.append('confirmed first parent checked before explicit second request')
        os.write(self.master, trial.SECOND.encode()+b'\n')

    def drive_pty(self):
        segment = self.out[self.segment_out:]+self.err[self.segment_err:]
        if not self.current_request and REQUEST_PROMPT in segment:
            self.current_request = True; os.write(self.master, trial.FIRST.encode()+b'\n')
            self.milestones.append('first request sent only after outer prompt')
        if NATIVE_PROMPT in segment and not self.current_native:
            assert self.case != 'B4'
            assert self.preview.encode().rstrip(b'\n') in segment.replace(b'\r\n', b'\n'), 'native consent preceded exact preview'
            rows = self.live_rows(); selected = self.server.item
            chain.assert_record(selected, rows[chain.CHAIN]['turn:'+str(selected['turn'])]['value'], 'admitted', self.binding)
            assert (self.directory/'workspace'/trial.TARGET).read_bytes() == selected['before'].encode()
            assert 'turn:'+str(selected['turn']) not in rows.get(chain.JOURNAL, {})
            self.record.setdefault('confirmation_resources', []).append(trial.resources())
            self.current_native = True; os.write(self.master, b'yes\n')
            self.milestones.append('native yes for turn '+str(selected['turn']))
        if chain.work.edit.PROMPT in segment and not self.current_nomo:
            assert self.current_native
            self.current_nomo = True; os.write(self.master, b'y\n')
            self.milestones.append('Nomo y for turn '+str(self.server.item['turn']))
        if self.case == 'B3' and self.server.item['turn'] == 1 and self.out.count(REQUEST_PROMPT) == 2:
            assert self.current_native and self.current_nomo and b'SAVED v2 summary-confirmed' in self.out
            if all(item['finished'].is_set() for item in self.server.records) and self.server.settled():
                self.next_turn()

    def run(self):
        command = self.commands(); env = trial.environment(self.directory, 'trace-terminal002.json', True)
        self.record['command'] = command
        use_pty = self.case in ['B3', 'B4', 'B5']
        if use_pty:
            master, slave = pty.openpty(); self.master = master
            settings = termios.tcgetattr(slave); settings[3] &= ~(termios.ECHO|termios.ECHONL); settings[1] &= ~termios.ONLCR
            termios.tcsetattr(slave, termios.TCSANOW, settings)
            self.process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=subprocess.PIPE, start_new_session=True)
            os.close(slave); readers = {master, self.process.stderr.fileno()}
        else:
            self.process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            self.process.stdin.write((trial.FIRST+'\ny\n'+trial.SECOND+'\n').encode())
            self.process.stdin.close()
            readers = {self.process.stdout.fileno(), self.process.stderr.fileno()}
        self.record['launcher_pid'] = self.process.pid
        output_fd = self.master if use_pty else self.process.stdout.fileno()
        def read(fd):
            try:
                value = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                value = b''
            if not value:
                readers.discard(fd)
            elif fd == output_fd:
                self.out += value
            else:
                self.err += value
        deadline = time.monotonic()+180
        while True:
            for fd in select.select(list(readers), [], [], 0.02)[0]:
                read(fd)
            if time.monotonic() >= self.next_owner_poll:
                self.discover(); self.next_owner_poll = time.monotonic()+0.2
                if self.owner and self.owner.get('running') and 'initial_resources' not in self.record and self.process.poll() is None:
                    self.record['initial_resources'] = trial.resources()
            self.observe_error()
            if use_pty:
                self.drive_pty()
            if self.held.is_set() and self.sent_signal_at is None:
                self.terminate(signal.SIGINT if self.case == 'B4' else signal.SIGTERM)
            if self.process.poll() is not None:
                for fd in list(readers):
                    while fd in readers and select.select([fd], [], [], 0)[0]:
                        read(fd)
                self.record['exit'] = self.process.wait()
                break
            limit = self.sent_signal_at+12 if self.sent_signal_at is not None else deadline
            assert time.monotonic() < limit, 'owned launcher exceeded finite execution/cleanup deadline'

    def cleanup(self):
        errors = []
        if self.process is not None:
            if self.process.poll() is None:
                self.terminate(signal.SIGTERM)
                try:
                    self.process.wait(timeout=max(0.01, self.sent_signal_at+12-time.monotonic()))
                except subprocess.TimeoutExpired:
                    errors.append('owned launcher did not end within helper cleanup bound; no broad kill attempted')
            self.record['exit'] = self.process.poll()
            try:
                self.discover()
                assert self.owner and self.owner.get('id'), 'owner UUID/name/container ID was not captured by exact inspection; cleanup remains unproven'
                assert inspected(self.owner['name']) is None, 'owned container remains after launcher exit'
                if self.client is not None:
                    check = subprocess.run(['ps', '-ww', '-p', str(self.client['pid']), '-o', 'command='], capture_output=True, text=True, timeout=5)
                    assert check.returncode in [0, 1]
                    assert check.stdout.strip() != self.client['command'], 'owned Compose client remains'
                self.record['owned_cleanup_confirmed'] = self.process.poll() is not None
            except BaseException as error:
                errors.append(repr(error)); self.record['owned_cleanup_confirmed'] = False
        self.release_ok = self.record.get('owned_cleanup_confirmed', False)
        stable = False
        if self.server:
            deadline = time.monotonic()+6
            stopped = threading.Thread(target=self.server.shutdown, daemon=True) if self.thread and self.thread.is_alive() else None
            if stopped:
                stopped.start(); stopped.join(timeout=max(0.0, min(2.0, deadline-time.monotonic())))
            if self.thread and self.thread.ident is not None:
                self.thread.join(timeout=max(0.0, min(2.0, deadline-time.monotonic())))
            listener_done = (stopped is None or not stopped.is_alive()) and (self.thread is None or not self.thread.is_alive())
            self.server.server_close()
            if not self.release_ok:
                # Abort sockets before unblocking a held callback; it cannot supply a valid response.
                self.server.abort_sockets()
            self.gate.set()
            settled = self.server.joined(min(deadline, time.monotonic()+2))
            if not settled:
                self.server.abort_sockets()
                settled = self.server.joined(deadline)
            with self.server.lock:
                current = list(self.server.records)
            finished = all(item['finished'].is_set() for item in self.all_requests+current)
            with self.server.handler_lock:
                handlers = [dict(thread=item['thread'].name, done=item['done'].is_set(),
                                 alive=item['thread'].is_alive(), errors=list(item['errors'])) for item in self.server.handlers]
            stable = listener_done and settled and finished and len(handlers) == len(self.all_requests)+len(current)
            self.record['HTTP_observer'] = dict(stable=stable, listener_done=listener_done, all_finished_events=finished,
                handlers=handlers, read_timeout_seconds=3, final_join_bound_seconds=6,
                held_response_release='valid only after owned termination' if self.release_ok else 'aborted sockets; no valid held response')
            if stable:
                self.all_requests.extend(current)
                self.completed_turns.append(dict(item=self.server.item, binding=self.binding,
                    prior=chain.parent_facts(self.record['first_parent']['value']) if self.case == 'B3' and 'first_parent' in self.record else [],
                    requests=list(current)))
            else:
                errors.append('HTTP listener/handler/event lifetime is unproven; exact counts unavailable; no reservation refund')
                self.all_requests.extend(current)
        else:
            self.record['HTTP_observer'] = dict(stable=False, qualification='server did not start')
        if stable:
            http = [{key:value for key,value in item.items() if key != 'finished'} for item in self.all_requests]
        else:
            # In-flight records may still mutate. Retain immutable arrival bytes and lower bounds only.
            http = [dict(request_base64=item.get('request_base64'), finished=item['finished'].is_set(),
                         qualification='unstable observer; mutable request/context/result fields omitted') for item in self.all_requests]
        self.record['HTTP'] = http
        if stable:
            chain.reply = ORIGINAL_REPLY; trial.active_container = ORIGINAL_CONTAINER
        # Unsettled daemon handlers retain the exact-owner, fail-closed adapters until process exit.
        self.record.update(owner=deepcopy(self.owner), owned_client=deepcopy(self.client))
        if self.held_resources is not None:
            self.record['held_resources'] = deepcopy(self.held_resources)
        for stream in [getattr(self.process, 'stdout', None), getattr(self.process, 'stderr', None)]:
            if stream is not None:
                stream.close()
        if self.master is not None:
            os.close(self.master)
        (self.folder/'terminal.stdout.bin').write_bytes(self.out); (self.folder/'terminal.stderr.bin').write_bytes(self.err)
        self.record.update(stdout=self.out.decode(errors='replace'), stderr=self.err.decode(errors='replace'), milestones=self.milestones)
        return errors


def trace_observation(directory, name='trace-terminal002.json'):
    path = directory/'state'/name
    if not path.exists():
        return dict(path=str(path), present=False, actions=None, termination=None, complete=False)
    try:
        trace = json.loads(path.read_text()); actions = chain.work.actions(trace)
        started = {item['id'] for item in trace['events'] if item['kind'] == 'host_request_started'}
        finished = {item['id'] for item in trace['events'] if item['kind'] == 'host_request_finished'}
        termination = trace.get('termination')
        return dict(path=str(path), present=True, actions=actions, termination=termination, outcome=trace.get('outcome'),
                    complete=isinstance(termination, dict) and termination.get('local_work_settled') is True and started <= finished)
    except (OSError, ValueError, KeyError, TypeError) as error:
        return dict(path=str(path), present=True, actions=None, termination=None, complete=False, parse_error=repr(error))


def shown(folder, directory, selected, phase, reads, journal):
    before = chain.work.edit.previous.inspect(directory/'state')
    name = 'show-turn-'+str(selected['turn']); trace = 'trace-'+name+'.json'
    observed, record = trial.plain(folder, name, 'show', directory, trial.selectors(selected), trace=trace)
    assert observed.returncode == 0, 'new-process show failed'
    assert chain.work.edit.previous.inspect(directory/'state') == before, 'show changed logical SQLite rows/versions'
    proof = trace_observation(directory, trace); actions = proof['actions']
    assert proof['complete'] and set(actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'}
    assert actions.count('Memory.read') == reads
    groups = {}
    for line in observed.stdout.decode().splitlines():
        prefix, _, value = line.partition(' ')
        if value.startswith('{'):
            groups.setdefault(prefix, []).append(json.loads(value))
    if phase == 'empty':
        assert b'CHAIN missing' in observed.stdout and not groups
    else:
        rows = chain.rows(directory/'state'); row = rows[chain.CHAIN]['turn:'+str(selected['turn'])]['value']
        binding, _ = chain.work.edit.expected(selected)
        chain.assert_record(selected, row, phase, binding)
        assert groups['CHAIN'][0]['phase'] == phase and groups['CHAIN'][0]['chain'] == trial.ROOT_ID
        assert groups['CHAIN'][0]['id'] == selected['id'] and groups['CHAIN'][0]['parent_id'] == ('' if selected['turn'] == 1 else trial.ROOT_ID)
        assert groups['REMAINING'][0] == {key:str(value) for key,value in (chain.TURN if selected['turn'] == 1 else chain.ZERO).items()}
        if journal:
            assert groups['JOURNAL'][0]['phase'] == journal
            assert groups['EDIT'][0]['before'] == selected['before'] and groups['EDIT'][0]['after'] == selected['after']
            assert groups['EDIT'][0]['summary'] == (selected['final_summary'] if phase == 'summary-confirmed' else '')
        else:
            assert 'WORK' not in groups and 'JOURNAL' not in groups
        assert b'Captured facts, not current File state.' in observed.stdout
    record.update(trace=proof, groups=groups, logical_rows_unchanged=True)
    return record


def validate(driver, record):
    case, directory = driver.case, driver.directory
    assert record.get('owned_cleanup_confirmed'), 'owned cleanup unconfirmed; host SQL and show were not attempted'
    rows = chain.rows(directory/'state'); record['final_rows'] = rows
    after = (directory/'workspace'/trial.TARGET).read_bytes()
    record['actual_file_after_base64'] = chain.base64.b64encode(after).decode()
    assert len(after) <= 2048 and set(rows) <= {chain.CHAIN, chain.JOURNAL}
    record['shows'] = []
    first = trial.item(1, case == 'B2')
    if case == 'B1':
        assert rows == {} and after == first['before'].encode()
        record['qualifications'].append('Native startup may initialize empty SQLite schema/metadata before argument refusal; zero work admission means no application rows or application Memory.write, not unchanged physical DB bytes.')
        record['shows'].append(shown(driver.folder, directory, first, 'empty', 2, None))
    else:
        phase = 'summary-confirmed' if case == 'B3' else 'summary-unconfirmed' if case == 'B5' else 'admitted'
        binding, _ = chain.work.edit.expected(first)
        chain.assert_record(first, rows[chain.CHAIN]['turn:1']['value'], phase, binding)
        expected = 'green\n' if case == 'B3' else first['after'] if case == 'B5' else first['before']
        assert after == expected.encode()
        if case in ['B2', 'B4']:
            assert rows.get(chain.JOURNAL, {}) == {}
        else:
            assert rows[chain.JOURNAL]['turn:1']['value'] == dict(format=2, chain=trial.ROOT_ID, turn=1, phase='completed', binding=binding)
        record['shows'].append(shown(driver.folder, directory, first, phase, 10 if case == 'B3' else 8 if case == 'B5' else 6, 'completed' if case in ['B3', 'B5'] else None))
        if case == 'B3':
            second = trial.item(2); second_binding, _ = chain.work.edit.expected(second)
            chain.assert_record(second, rows[chain.CHAIN]['turn:2']['value'], 'summary-confirmed', second_binding)
            assert rows[chain.CHAIN]['turn:1'] == record['first_parent'], 'confirmed parent mutated'
            assert rows[chain.JOURNAL]['turn:2']['value'] == dict(format=2, chain=trial.ROOT_ID, turn=2, phase='completed', binding=second_binding)
            record['shows'].append(shown(driver.folder, directory, second, 'summary-confirmed', 10, 'completed'))
    assert record.get('HTTP_observer', {}).get('stable'), 'HTTP observer still active or incomplete; exact counts unproven'
    for turn in driver.completed_turns:
        chain.assert_http(turn['item'], turn['requests'], turn['binding'], turn['prior'])
    expected_http = dict(B1=0, B2=6, B3=14, B4=1, B5=7)[case]
    assert len(driver.all_requests) == expected_http
    if case in ['B4', 'B5']:
        assert driver.held.is_set() and record['exit'] == (130 if case == 'B4' else 143), 'signal did not preserve meaningful exit status'
    else:
        assert (record['exit'] == 0) == (case == 'B3'), 'terminal result differs'
    trace = record['trace']; actions = trace['actions']
    if not trace['complete']:
        raise AssertionError('native trace/termination incomplete; cannot pass cancellation or count requirements')
    assert actions is not None
    counts = record['counts']
    assert counts['logical_inference_starts'] == expected_http and counts['native_model_action_starts'] == expected_http
    assert counts['atomic_replace_starts'] == dict(B1=0, B2=0, B3=2, B4=0, B5=1)[case]
    assert actions.count('Memory.write') == dict(B1=0, B2=1, B3=10, B4=1, B5=4)[case]
    assert actions.count('Approval.request') == dict(B1=0, B2=1, B3=2, B4=0, B5=1)[case]
    assert actions.count('Console.stdin_read_line') == dict(B1=0, B2=0, B3=4, B4=1, B5=2)[case]
    combined = driver.out+driver.err
    if case in ['B1', 'B2']:
        assert NATIVE_PROMPT not in combined and chain.work.edit.PROMPT not in combined and REQUEST_PROMPT not in combined
    if case == 'B1':
        assert b'non-TTY terminal mode requires explicit --once REQUEST' in driver.out and b'USER ' not in driver.out
    if case == 'B2':
        assert driver.preview.encode().rstrip(b'\n') in driver.out.replace(b'\r\n', b'\n')
        assert driver.out.count(b'USER ') == 1 and trial.SECOND.encode() not in driver.out
    if case == 'B3':
        assert combined.count(NATIVE_PROMPT) == combined.count(chain.work.edit.PROMPT) == 2
        sessions = [json.loads(line[8:]) for line in driver.out.decode().splitlines() if line.startswith('SESSION ')]
        assert [(item['phase'], item['current_id'], item['configured_turns_in_process']) for item in sessions] == [('first',trial.ROOT_ID,'2'),('second',trial.CHILD_ID,'1'),('stopped',trial.CHILD_ID,'0')]
        assert driver.out.count(b'USER ') == 2 and driver.out.count(REQUEST_PROMPT) == 2


def execute(case, evidence, record):
    directory = evidence/'fresh-fixture'
    if not record.get('fixture_prepared'):
        prepare_fixture(evidence, record)
    assert chain.rows(directory/'state') == {}
    assert (directory/'workspace'/trial.TARGET).read_bytes() == b'old\n'
    driver = Driver(case, evidence, directory, record)
    errors = []
    try:
        driver.start_server(); driver.run()
    except BaseException:
        errors.append(traceback.format_exc())
    finally:
        errors.extend(driver.cleanup())
    record['trace'] = trace_observation(directory)
    actions = record['trace']['actions']
    native_starts = sum(chain.work.model_action(action) for action in actions) if actions is not None else None
    complete = record['trace']['complete']
    expected = dict(B1=0, B2=6, B3=14, B4=1, B5=7)[case]
    observer_stable = record.get('HTTP_observer', {}).get('stable', False)
    count_complete = complete and observer_stable
    stage_proof = count_complete and native_starts == len(driver.all_requests) == expected
    if stage_proof:
        try:
            for turn in driver.completed_turns:
                chain.assert_http(turn['item'], turn['requests'], turn['binding'], turn['prior'])
        except (AssertionError, KeyError, TypeError, ValueError):
            stage_proof = False
    if not complete:
        record['qualifications'].append('Missing/partial native trace or termination report: exact application call/approval/atomic counts and active-turn cancellation remain unproven. Owned cleanup and file/SQL/show observations are separate.')
    if not observer_stable:
        record['qualifications'].append('HTTP observer did not settle: listener/handlers/finished events are retained; exact HTTP/native/logical/atomic counters remain None, known arrival/trace lower bounds only, full reservation retained.')
    if not stage_proof:
        record['qualifications'].append('Exact logical count unproven: native host starts are not logical starts on a partial trace, extra HTTP request or failed stage-context proof. Known logical lower bound is conservatively zero; the full reserved logical ceiling remains charged.')
    record['partial_trace_observed_starts'] = dict(logical_inference_starts=0, native_model_action_starts=native_starts or 0,
        HTTP_attempts=len(driver.all_requests), atomic_replace_starts=actions.count('Fs.atomic_replace') if actions is not None else 0)
    record['counts'] = dict(trace_complete=complete, observer_stable=observer_stable, logical_exact_proven=stage_proof,
                          logical_inference_starts=expected if stage_proof else None, native_model_action_starts=native_starts if count_complete else None,
                          HTTP_attempts=len(driver.all_requests) if observer_stable else None,
                          atomic_replace_starts=actions.count('Fs.atomic_replace') if count_complete else None,
                          qualification='Trace host-action starts and wire HTTP requests are independent observations. No native repair count is invented from a missing trace; source retry=1 is recorded separately.')
    if record.get('owned_cleanup_confirmed'):
        try:
            validate(driver, record)
        except BaseException:
            errors.append(traceback.format_exc())
    else:
        record['qualifications'].append('No host SQLite or new-process show was opened while owned writer termination remained unconfirmed.')
    assert not errors, '\n'.join(errors)


def prepare_fixture(evidence, record):
    directory = evidence/'fresh-fixture'
    prepared, record['prepare'] = trial.plain(evidence, 'prepare', 'prepare', directory)
    assert prepared.returncode == 0, 'fresh fixture preparation failed'
    assert chain.rows(directory/'state') == {} and (directory/'workspace'/trial.TARGET).read_bytes() == b'old\n'
    record['fixture_prepared'] = True


def mounted_profile(evidence, record):
    directory = evidence/'fresh-fixture'
    env = trial.environment(directory, model=True)
    env.update(NOMO_EDIT_STATE_DIR=str(directory/'state'), NOMO_EDIT_WORKSPACE_DIR=str(directory/'workspace'),
               NOMO_WORK_CONTEXT_DIR=str(directory/'context'))
    command = ['docker','compose','--env-file','/dev/null']
    for name in ['compose.yaml','config/etas-runtime-cache-compose.yaml','config/local-tryout-compose.yaml',
                 'config/edit-operation-compose.yaml','config/harness-work-compose.yaml','config/local-tryout-model-compose.yaml']:
        command += ['--file', str(ROOT/name)]
    command += ['run','--rm','--no-deps','--pull','never','--tty=false','-e','ETAS_HOST_APPROVAL=deny','dev',
                'etas','run','/workspace','--flow','terminal_once','--profile','work-chain-once','--print-runtime-profile']
    observed = subprocess.run(command, cwd=ROOT, env=env, input=b'', capture_output=True, timeout=120)
    value = trial.retain(evidence, 'mounted-effective-profile', command, observed)
    record['mounted_effective_profile'] = value
    assert observed.returncode == 0, 'mounted effective profile failed; retained raw output'
    profile = json.loads(observed.stdout); value['profile'] = profile
    assert profile['approval'] == 'Deny', 'effective native Approval must be Deny'
    assert profile['model']['retry'] == dict(attempts=1, delay_ms=0), 'effective HTTP attempts must be one'
    value['qualification'] = 'Actual mounted runtime-profile print only: no flow execution, Model request or work admission; existing B timeouts remain 120000/2000ms.'
    assert chain.rows(directory/'state') == {}, 'profile print must not admit application work'
    record['controls_prepared'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=list(BOUNDS), required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True, help='Existing shared A/B batch ledger; never initialized/reset here')
    parser.add_argument('--correction-review', default='', help='Concrete fix and independent TL review reference; one retest per failed case')
    parser.add_argument('--prepare-only', action='store_true', help='B1 fresh fixture and mounted profile print only; no case/admission/ledger reservation')
    parser.add_argument('--prepared-evidence', type=Path, help='Consume same untouched B1 pair from successful --prepare-only')
    options = parser.parse_args()
    assert options.ledger.is_file(), 'explicit existing shared batch ledger required'
    assert not options.prepare_only or (options.case == 'B1' and options.prepared_evidence is None)
    assert options.prepared_evidence is None or (options.case == 'B1' and not options.prepare_only)
    facts = source_facts(); chain.work.MODEL = facts['model']; chain.work.TOKEN = TOKEN
    options.evidence_dir.mkdir(parents=True, exist_ok=True)
    if options.prepared_evidence:
        evidence = options.prepared_evidence.resolve(strict=True)
        record = json.loads((evidence/'results.json').read_text())
        assert record['case'] == 'B1' and record['status'] == 'prepared-controls' and record['controls_prepared']
        assert record['source'] == facts and not record.get('ledger_attempt'), 'prepared pair source changed or work already attempted'
        assert record['ledger'] == str(options.ledger.resolve())
    else:
        evidence = Path(tempfile.mkdtemp(prefix='terminal002-'+options.case+'-', dir=options.evidence_dir)).resolve()
        record = dict(task='TERMINAL-002', case=options.case, status='prepared', source=facts,
                      fixture_provider='owned synthetic local scripted HTTP; no actual Qwen request', qualifications=[],
                      reserved=BOUNDS[options.case], ledger=str(options.ledger.resolve()))
    print('EVIDENCE '+str(evidence), flush=True)
    output = evidence/'results.json'; save(output, record)
    if options.prepare_only:
        try:
            prepare_fixture(evidence, record); mounted_profile(evidence, record); record['status'] = 'prepared-controls'
        except BaseException:
            record.update(status='preflight-failed', failure=traceback.format_exc())
        finally:
            save(output, record)
        print(record['status'].upper()+' '+str(output), flush=True)
        return 0 if record['status'] == 'prepared-controls' else 1
    identity = reserve(options.ledger, options.case, evidence, options.correction_review)
    record.update(status='running', ledger_attempt=identity); save(output, record)
    try:
        execute(options.case, evidence, record)
        record['status'] = 'passed'
    except BaseException:
        record.update(status='failed', failure=traceback.format_exc())
    finally:
        save(output, record)
        try:
            finish_ledger(options.ledger, identity, record)
        except BaseException:
            record.update(status='failed', ledger_update_failure=traceback.format_exc())
            save(output, record)
    print(record['status'].upper()+' '+options.case+' '+str(output), flush=True)
    return 0 if record['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
