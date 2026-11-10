"""Native Etas model port and the rolling model-context projection."""
from pathlib import Path
from typing import Protocol
import json
import math
import os
import queue
import re
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent


class ProjectModel(Protocol):
    def next(self, context): ...
    def summarize(self, context): ...
    def close(self): ...


class NativeModel:
    """Etas model adapter with an immutable input for each native invocation."""
    def __init__(self):
        self.directory = None
        self.process = None
        self.lines = queue.Queue()
        self.errors = []
        self.usage = {}
        self.usage_events = []

    def start(self, operation):
        (ROOT / '.etas').mkdir(mode=0o700, exist_ok=True)
        # The read-only container worker runs as the existing nomo user.
        environment = dict(os.environ, NOMO_PROJECT_REQUEST=str(self.request))
        command = ['docker', 'compose', '--env-file', '/dev/null']
        for name in ('compose.yaml', 'config/etas-0120-official-compose.yaml', 'config/local-tryout-compose.yaml',
                     'config/etas-runtime-cache-compose.yaml', 'config/nomo-project-compose.yaml'):
            command += ['--file', str(ROOT / name)]
        command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                    'python3', '-B', '/workspace/scripts/nomo-verified-etas.py', 'run', '/workspace',
                    '--flow', 'project_agent', '--profile', 'nomo-project', '--allow-effects', '--args', operation]
        self.lines, self.errors = queue.Queue(), []
        self.process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
                                        start_new_session=True)
        self.readers = [threading.Thread(target=self.stdout, daemon=True), threading.Thread(target=self.stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def stdout(self):
        for line in self.process.stdout:
            self.lines.put(line.rstrip('\n'))
        self.lines.put(None)

    def stderr(self):
        for line in self.process.stderr:
            self.errors.append(line.rstrip())
            match = re.search(r'MODEL completed in ([\d.]+)s; input=(\d+) output=(\d+)', line)
            if match:
                self.usage = {'seconds': float(match[1]), 'input': int(match[2]), 'output': int(match[3])}
                self.usage_events.append(dict(self.usage))
                print(f'[MODEL  ] {match[1]}s · input {int(match[2]):,} · output {int(match[3]):,}', flush=True)
            elif 'MODEL HTTP' in line or 'MODEL rate limited' in line:
                print('[MODEL  ] ' + line.strip(), flush=True)

    def receive(self, prefix):
        started, notified = time.monotonic(), time.monotonic()
        while True:
            try:
                line = self.lines.get(timeout=1)
            except queue.Empty:
                if self.process.poll() is not None:
                    raise RuntimeError('\n'.join(self.errors[-12:]) or 'Etas worker stopped')
                if time.monotonic() - notified >= 30:
                    print(f'[MODEL  ] Working · {int(time.monotonic() - started)}s', flush=True)
                    notified = time.monotonic()
                continue
            if line is None:
                raise RuntimeError('\n'.join(self.errors[-12:]) or 'Etas worker stopped')
            if line.startswith(prefix):
                return line[len(prefix):].strip()
            if line == 'PROJECT COMPACT_REQUIRED':
                raise ValueError('context requires compression')

    def request_model(self, context, operation, prefix):
        if self.directory is None:
            self.directory = tempfile.TemporaryDirectory(prefix='nomo-project-model-')
            self.request = Path(self.directory.name)
        location = self.request / 'input.json'
        with location.open('w') as stream:
            json.dump(context, stream, ensure_ascii=False)
            stream.flush()
        location.chmod(0o600)
        self.start(operation)
        result = json.loads(self.receive(prefix))
        code = self.process.wait(timeout=30)
        for reader in self.readers:
            reader.join()
        if code:
            raise RuntimeError('\n'.join(self.errors[-12:]) or 'Etas worker stopped')
        self.process = None
        return result

    def next(self, context):
        return self.request_model(context, 'next', 'PROJECT ACTION ')

    def summarize(self, context):
        return self.request_model(context, 'compact', 'PROJECT SUMMARY ')

    def close(self):
        if self.process is not None and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=10)
        if self.directory:
            self.directory.cleanup()
            self.directory = None


def estimated_tokens(value):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    non_ascii = sum(ord(character) > 127 for character in text)
    return math.ceil((len(text) - non_ascii) / 3) + non_ascii * 2 + 4096


class RollingContext:
    def __init__(self, history, session, workspace, model):
        self.history, self.session, self.workspace, self.model = history, session, workspace, model

    def payload(self, messages):
        config = self.workspace.config
        initial, request = self.history.requests(self.session)
        result = {'root': str(self.workspace.root), 'initial_request': initial,
                  'request': request, 'instructions': self.workspace.instructions(), 'history': messages,
                  'context_window': min(config.context_window, 1048576), 'output_allowance': min(config.max_output_tokens, 131072),
                  'estimated_tokens': 0}
        result['estimated_tokens'] = estimated_tokens(result)
        usage = json.loads(self.history.session(self.session)['usage'])
        if usage.get('estimated') and usage.get('input'):
            result['estimated_tokens'] = max(result['estimated_tokens'], math.ceil(result['estimated_tokens'] * usage['input'] / usage['estimated']))
        return result

    def current(self):
        messages = self.history.context(self.session)
        value = self.payload(messages)
        threshold = (value['context_window'] - value['output_allowance']) * self.workspace.config.compact_ratio
        while value['estimated_tokens'] > threshold and len(messages) > 2:
            before = value['estimated_tokens']
            self.compact()
            messages = self.history.context(self.session)
            value = self.payload(messages)
            if value['estimated_tokens'] >= before:
                break
        return value

    def compact(self, force=False):
        messages = self.history.context(self.session)
        if len(messages) <= 2:
            return False
        keep = min(self.workspace.config.keep_messages, max(2, len(messages) // 3))
        allowance = int((self.workspace.config.context_window - self.workspace.config.max_output_tokens) * self.workspace.config.compact_ratio)
        while keep > 1 and estimated_tokens(messages[-keep:]) > allowance // 2:
            keep -= 1
        if estimated_tokens(messages[-1:]) > allowance // 2:
            keep = 0
        prefix = messages[:-keep] if keep else messages
        if not prefix:
            return False
        print(f'[CONTEXT] Summarizing {len(prefix)} messages; full history remains saved.', flush=True)
        # Incremental summaries keep each summarization request inside the same
        # provider window, even when reopening a much larger imported archive.
        limit = int((self.workspace.config.context_window - 131072) * 0.65)
        batches, batch = [], []
        for message in prefix:
            if batch and estimated_tokens(batch + [message]) > limit:
                batches.append(batch); batch = []
            if estimated_tokens([message]) > limit:
                width = max(1024, limit // 2)
                for offset in range(0, len(message['content']), width):
                    batches.append([{**message, 'content': message['content'][offset:offset + width]}])
            else:
                batch.append(message)
        if batch:
            batches.append(batch)
        summary = ''
        for batch in batches:
            if summary:
                batch = [{'id': 0, 'role': 'system', 'name': 'previous_summary', 'content': summary}, *batch]
            summary = self.model.summarize(self.payload(batch))
        self.history.compact(self.session, prefix[-1]['id'], summary)
        return True

    def record_usage(self, payload):
        if self.model.usage:
            self.history.usage(self.session, {**self.model.usage, 'estimated': payload['estimated_tokens']})
