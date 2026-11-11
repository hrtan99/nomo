#!/usr/bin/env python3
"""Keep an Etas container alive; forward terminal bytes without product decisions."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import termios
import tempfile
import tty


def docker(*arguments):
    return subprocess.check_output(['docker', *arguments], text=True).strip()


def state(identifier):
    return json.loads(docker('inspect', '--format', '{{json .State}}', identifier))


def write_bytes(descriptor, data):
    remaining = memoryview(data)
    while remaining:
        remaining = remaining[os.write(descriptor, remaining):]


def attach(identifier, terminal, control):
    # Engine attach atomically replays retained terminal output and follows live
    # bytes. No model text is parsed, and no task or approval input is generated.
    diagnostics = tempfile.TemporaryFile()
    connection = subprocess.Popen(['docker', 'system', 'dial-stdio'], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=diagnostics, bufsize=0)
    request = ('POST /containers/' + identifier + '/attach?logs=1&stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\n'
               'Host: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n')
    settings = None
    pending = b''
    input_active = True
    frames = bytearray()

    def output(data):
        if terminal:
            write_bytes(sys.stdout.fileno(), data)
            return
        # Non-TTY Engine streams have an eight-byte stdout/stderr frame header.
        frames.extend(data)
        while len(frames) >= 8:
            size = int.from_bytes(frames[4:8], 'big')
            if len(frames) < 8 + size:
                break
            destination = sys.stderr.fileno() if frames[0] == 2 else sys.stdout.fileno()
            write_bytes(destination, frames[8:8 + size])
            del frames[:8 + size]
    try:
        write_bytes(connection.stdin.fileno(), request.encode('ascii'))
        headers = bytearray()
        while b'\r\n\r\n' not in headers:
            chunk = os.read(connection.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('Docker attach ended before its HTTP response')
            headers.extend(chunk)
        header, initial = bytes(headers).split(b'\r\n\r\n', 1)
        if not header.startswith(b'HTTP/1.1 101 '):
            raise RuntimeError('Docker attach refused: ' + header.split(b'\r\n', 1)[0].decode())
        if sys.stdin.isatty():
            settings = termios.tcgetattr(sys.stdin.fileno())
            tty.setraw(sys.stdin.fileno())
        if initial:
            output(initial)
        while True:
            if (control / 'next-project').is_file():
                return 'project'
            descriptors = [connection.stdout.fileno()]
            if input_active:
                descriptors.append(sys.stdin.fileno())
            readable, _, _ = select.select(descriptors, [], [], 0.1)
            if connection.stdout.fileno() in readable:
                chunk = os.read(connection.stdout.fileno(), 65536)
                if not chunk:
                    return
                output(chunk)
            if sys.stdin.fileno() in readable:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    if settings is not None:
                        return  # Terminal loss detaches without closing worker stdin.
                    input_active = False  # A noninteractive invocation still waits for its result.
                    continue
                data = pending + chunk
                if b'\x10\x11' in data:
                    before = data.split(b'\x10\x11', 1)[0]
                    if before:
                        write_bytes(connection.stdin.fileno(), before)
                    return
                pending = b'\x10' if data.endswith(b'\x10') else b''
                data = data[:-1] if pending else data
                if data:
                    write_bytes(connection.stdin.fileno(), data)
    finally:
        if settings is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, settings)
        connection.stdin.close()
        connection.terminate()
        connection.wait()
        if sys.exc_info()[0] is not None and sys.exc_info()[0] is not SystemExit:
            diagnostics.seek(0)
            write_bytes(sys.stderr.fileno(), diagnostics.read())
        diagnostics.close()


def main(command):
    def disconnected(number, _frame):
        raise SystemExit(128 + number)
    signal.signal(signal.SIGHUP, disconnected)
    signal.signal(signal.SIGTERM, disconnected)
    workspace = os.environ['NOMO_NATIVE_WORKSPACE']
    directory = Path(os.environ['NOMO_NATIVE_STATE'])
    # This is container/terminal identity only. Conversation selection, durable
    # product state, tool dispatch and recovery stay inside Etas.
    identity = hashlib.sha256(os.fsencode(str(Path(__file__).resolve().parent.parent)) + b'\0' +
                              os.fsencode(directory) + b'\0' + os.fsencode(workspace)).hexdigest()
    name = 'nomo-native-worker-' + identity[:32]
    locks = directory / 'workers'
    locks.mkdir(mode=0o700, exist_ok=True)
    with (locks / (identity + '.lock')).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('This project already has an attached terminal client')
        identifiers = docker('ps', '--all', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}')
        existing = bool(identifiers)
        if existing:
            labels = json.loads(docker('inspect', '--format', '{{json .Config.Labels}}', identifiers))
            if labels.get('nomo.native.worker') != identity:
                raise RuntimeError('The container name belongs to another execution endpoint')
            observed = state(identifiers)
            if observed['Status'] == 'exited':
                print('[WORKER ] Previous execution exited with status ' + str(observed['ExitCode']), flush=True)
                subprocess.run(['docker', 'rm', identifiers], check=True, stdout=subprocess.DEVNULL)
                existing = False
            elif observed['Status'] != 'running':
                raise RuntimeError('Execution endpoint is ' + observed['Status'] + '; inspect it before reconnecting')
        if existing:
            # Startup arguments belong to the Etas invocation, not to a terminal
            # attach. Never inject them into a possibly pending approval prompt.
            source_arguments = command[command.index('--args') + 1:]
            if source_arguments != ['--workspace', workspace]:
                raise RuntimeError('An execution endpoint is already running. Reconnect without startup arguments; select conversations with native /new or /resume commands')
            evidence = Path(labels['nomo.native.evidence'])
            control = Path(labels['nomo.native.control'])
            identifier = identifiers
        else:
            evidence = Path(os.environ['NOMO_NATIVE_EVIDENCE'])
            control = Path(os.environ['NOMO_NATIVE_CONTROL_DIR'])
            index = command.index('run')
            service = command.index('dev', index + 1)
            options = [part for part in command[index + 1:service] if part not in ('--rm', '--tty=true', '--tty=false')]
            command = command[:index + 1] + ['--detach', '--interactive', '--tty=' + str(sys.stdin.isatty()).lower(), '--name', name,
                '--label', 'nomo.native.worker=' + identity,
                '--label', 'nomo.native.evidence=' + str(evidence),
                '--label', 'nomo.native.control=' + str(control)] + options + command[service:]
            identifier = subprocess.check_output(command, text=True).strip()
        print('[PROJECT] ' + workspace + '\n[STATE  ] ' + str(directory) + '\n[TRACE  ] ' + str(evidence) +
              '\n[WORKER ] ' + identifier + '\n[CLIENT ] Ctrl+P then Ctrl+Q detaches; /quit shuts down this execution endpoint. Retained terminal output follows.', flush=True)
        terminal = json.loads(docker('inspect', '--format', '{{json .Config.Tty}}', identifier))
        reason = attach(identifier, terminal, control)
        destination = Path(os.environ['NOMO_NATIVE_EVIDENCE']) / 'next-project'
        observed = state(identifier)
        if reason == 'project':
            # Consume only the native source's private mount request, never a
            # terminal/model marker. The delivered file is outside LaunchRoot,
            # so it cannot trigger the same request on a later reattachment.
            shutil.move(str(control / 'next-project'), destination)
            if observed['Status'] == 'exited':
                subprocess.run(['docker', 'rm', identifier], check=True, stdout=subprocess.DEVNULL)
                if observed['ExitCode'] != 0:
                    return observed['ExitCode']
                print('\n[CLIENT ] Project chooser completed; attaching the selected project.', flush=True)
            else:
                print('\n[CLIENT ] Switching project; the current execution endpoint remains running.', flush=True)
            return 0
        if observed['Status'] == 'running':
            print('\n[CLIENT ] Detached; the Etas execution endpoint remains running.', flush=True)
            return 0
        if observed['Status'] != 'exited':
            raise RuntimeError('Execution endpoint is ' + observed['Status'] + '; its result is not established')
        code = observed['ExitCode']
        if code == 0 and (control / 'next-project').is_file():
            shutil.move(str(control / 'next-project'), destination)
        subprocess.run(['docker', 'rm', identifier], check=True, stdout=subprocess.DEVNULL)
        return code


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print('[ERROR  ] ' + str(error), file=sys.stderr)
        sys.exit(1)
