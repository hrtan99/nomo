"""Persistent PTY jobs, shared by project tools and terminal commands."""
from pathlib import Path
import argparse
import errno
import hashlib
import json
import os
import pty
import secrets
import selectors
import signal
import socket
import subprocess
import sys
import threading
import time
from nomo_project import write_json


def control_path(directory):
    base = Path('/tmp') / ('nomo-jobs-' + str(os.getuid()))
    base.mkdir(mode=0o700, exist_ok=True)
    return base / (hashlib.sha256(str(Path(directory).resolve()).encode()).hexdigest()[:24] + '.sock')


class ProcessService:
    def __init__(self, state, root):
        self.base, self.root = Path(state) / 'jobs', str(Path(root).resolve())
        self.base.mkdir(parents=True, exist_ok=True, mode=0o700)

    def start(self, arguments, cwd=None):
        identifier = secrets.token_hex(8)
        directory = self.base / identifier
        directory.mkdir(mode=0o700)
        with (directory / 'daemon.log').open('ab') as diagnostic:
            process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--run', str(directory),
                                        '--root', cwd or self.root, '--', *arguments],
                                       stdin=subprocess.DEVNULL, stdout=diagnostic, stderr=diagnostic, start_new_session=True)
        for _ in range(100):
            if (directory / 'status.json').exists():
                threading.Thread(target=process.wait, daemon=True).start()
                return {'job': identifier, **self.poll(identifier)}
            if process.poll() is not None:
                raise RuntimeError((directory / 'daemon.log').read_text() or 'terminal job could not start')
            time.sleep(0.02)
        return {'job': identifier, 'status': 'starting', 'pid': process.pid}

    def directory(self, identifier):
        selected = (self.base / identifier).resolve()
        if selected.parent != self.base.resolve():
            raise ValueError('invalid job ID')
        return selected

    def poll(self, identifier, offset=0, maximum=262144):
        directory = self.directory(identifier)
        value = json.loads((directory / 'status.json').read_text())
        if value['root'] != self.root:
            raise ValueError('job belongs to another project')
        with (directory / 'output.log').open('rb') as stream:
            stream.seek(offset)
            content = stream.read(maximum)
            next_offset = stream.tell()
            more = bool(stream.read(1))
        return {**value, 'output': content.decode('utf-8', 'replace'), 'offset': next_offset, 'more': more}

    def send(self, identifier, text='', stop=False):
        directory = self.directory(identifier)
        self.poll(identifier)
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(str(control_path(directory)))
            client.sendall(json.dumps({'text': text, 'stop': stop}).encode())
            client.shutdown(socket.SHUT_WR)
            client.recv(1024)
        return self.poll(identifier)

    def jobs(self):
        rows = []
        for directory in sorted(self.base.iterdir()):
            source = directory / 'status.json'
            if source.exists():
                value = json.loads(source.read_text())
                if value['root'] == self.root:
                    rows.append({'job': directory.name, **value})
        return rows

    def execute(self, arguments, timeout=600):
        result = self.start(arguments)
        identifier, deadline = result['job'], time.monotonic() + timeout
        shown = 0
        while result['status'] == 'running' and time.monotonic() < deadline:
            time.sleep(0.05)
            chunk = self.poll(identifier, shown)
            if chunk['output']:
                print(chunk['output'], end='', flush=True)
                shown = chunk['offset']
            result = self.poll(identifier)
        if result['status'] == 'running':
            return {'job': identifier, **result, 'notice': 'Still running. Use poll, write_stdin or stop; the process was retained.'}
        return {'job': identifier, **result}


def run_job(directory, root, arguments):
    directory = Path(directory)
    master, slave = pty.openpty()
    output = (directory / 'output.log').open('wb', buffering=0)
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(control_path(directory)))
    server.listen()
    process = subprocess.Popen(arguments, cwd=root, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    value = {'root': root, 'arguments': arguments, 'pid': process.pid, 'daemon': os.getpid(), 'status': 'running', 'exit_code': None}
    write_json(directory / 'status.json', value)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, 'output')
    selector.register(server, selectors.EVENT_READ, 'control')
    open_output = True
    while open_output or process.poll() is None:
        for key, _ in selector.select(0.1):
            if key.data == 'output':
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b''
                if data:
                    output.write(data)
                else:
                    selector.unregister(master)
                    open_output = False
            else:
                connection, _ = server.accept()
                with connection:
                    request = b''
                    while part := connection.recv(65536):
                        request += part
                    action = json.loads(request)
                    if action['stop'] and process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                    elif action['text'] and process.poll() is None:
                        os.write(master, action['text'].encode())
                    connection.sendall(b'ok')
    value.update(status='completed', exit_code=process.wait())
    write_json(directory / 'status.json', value)
    selector.close(); server.close(); output.close(); os.close(master)
    control_path(directory).unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    run_job(options.run, options.root, options.arguments[1:] if options.arguments[:1] == ['--'] else options.arguments)
