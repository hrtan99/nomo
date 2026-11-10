"""Keep a model call alive across explicit provider throttling responses."""
import email.utils
import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def provider_error(body, key):
    try:
        value = json.loads(body)
        error = value.get('error') or value.get('base_resp') or {}
        if isinstance(error, str): return '', error.replace(key, '[REDACTED]')[:1000]
        return str(error.get('code', error.get('status_code', ''))), str(error.get('message', error.get('status_msg', 'provider rejected request'))).replace(key, '[REDACTED]')[:1000]
    except (ValueError, AttributeError):
        return '', 'provider returned a non-JSON error'


def retry_delay(header, attempt):
    if header:
        try: return max(0, float(header))
        except ValueError:
            try: return max(0, email.utils.parsedate_to_datetime(header).timestamp() - time.time())
            except (ValueError, TypeError): pass
    return min(60, 15 * 2 ** attempt)


class ModelTransport(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass

    def do_POST(self):
        if self.path != '/v1/chat/completions' or self.headers.get('Authorization') != 'Bearer ' + self.server.token:
            self.send_error(403); return
        raw = self.rfile.read(int(self.headers['Content-Length']))
        payload = json.loads(raw)
        project_input = Path('/project-request/input.json')
        if project_input.is_file():
            allowance = json.loads(project_input.read_text()).get('output_allowance', 131072)
            payload['max_tokens'] = min(payload.get('max_tokens', 131072), allowance)
            raw = json.dumps(payload, ensure_ascii=False).encode()
        if payload.get('model') == 'MiniMax-M3.1-Flash':
            payload.setdefault('reasoning_effort', os.environ.get('NOMO_REASONING_EFFORT', 'medium'))
            raw = json.dumps(payload, ensure_ascii=False).encode()
        started = time.monotonic()
        body, status, headers = b'', 502, {}
        for attempt in range(5):
            request = urllib.request.Request(self.server.upstream + '/chat/completions', data=raw,
                headers={'Authorization': 'Bearer ' + self.server.key, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity'})
            try:
                with urllib.request.urlopen(request, timeout=self.server.deadline) as response:
                    body, status, headers = response.read(), response.status, response.headers
            except urllib.error.HTTPError as error:
                body, status, headers = error.read(), error.code, error.headers
            except (OSError, TimeoutError):
                # A disconnected request has no confirmed response to retry.
                body = b'{"error":{"message":"upstream connection failed"}}'
                status = 502; break
            if status != 429: break
            code, message = provider_error(body, self.server.key)
            wait = retry_delay(headers.get('Retry-After'), attempt)
            quota = any(word in message.lower() for word in ('5-hour', '5 hour', 'weekly', 'insufficient balance', '余额不足', '套餐额度', 'quota exhausted'))
            print('MODEL HTTP 429 code=' + code + ' ' + message, file=sys.stderr, flush=True)
            if quota or attempt == 4 or time.monotonic() - started + wait >= self.server.deadline:
                break
            print('MODEL rate limited; waiting ' + str(round(wait, 1)) + 's before attempt ' + str(attempt + 2) + '/5', file=sys.stderr, flush=True)
            if self.server.stopping.wait(wait): return
        if status >= 400 and status != 429:
            code, message = provider_error(body, self.server.key)
            print('MODEL HTTP ' + str(status) + ' code=' + code + ' ' + message, file=sys.stderr, flush=True)
        if status == 200:
            usage = json.loads(body).get('usage', {})
            print('MODEL completed in ' + str(round(time.monotonic() - started, 1)) + 's; input=' + str(usage.get('prompt_tokens', '?')) +
                ' output=' + str(usage.get('completion_tokens', '?')), file=sys.stderr, flush=True)
        self.send_response(status)
        self.send_header('Content-Type', headers.get('Content-Type', 'application/json'))
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass


def run(cli, arguments):
    if not arguments or arguments[0] != 'run' or '--profile' not in arguments:
        os.execv(str(cli), [str(cli), *arguments])
    profile = arguments[arguments.index('--profile') + 1]
    config = tomllib.loads(Path('/workspace/etas.toml').read_text())['runtime']['profiles'][profile].get('model', {})
    upstream = os.environ.get('ETAS_HOST_MODEL_BASE_URL', config.get('base_url', ''))
    if upstream != 'https://api.minimax.cn/v1':
        os.execv(str(cli), [str(cli), *arguments])
    key = os.environ.get('ETAS_HOST_MODEL_API_KEY') or os.environ.get(config.get('api_key_env', ''), '')
    server = ThreadingHTTPServer(('127.0.0.1', 0), ModelTransport)
    server.daemon_threads = True
    server.key, server.token, server.upstream = key, secrets.token_urlsafe(32), upstream
    server.deadline = int(os.environ.get('ETAS_HOST_MODEL_REQUEST_DEADLINE_MS', '600000')) / 1000
    server.stopping = threading.Event()
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    env = dict(os.environ, ETAS_HOST_MODEL_BASE_URL='http://127.0.0.1:' + str(server.server_port) + '/v1',
        ETAS_HOST_MODEL_API_KEY=server.token, ETAS_HOST_MODEL_ALLOW_PRIVATE='true')
    env.pop('MINIMAX_API_KEY', None)
    process = subprocess.Popen([str(cli), *arguments], env=env)
    def stop(number, _frame):
        server.stopping.set()
        if process.poll() is None: process.send_signal(number)
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(number, stop)
    try: return process.wait()
    finally:
        server.stopping.set(); server.shutdown(); server.server_close(); thread.join(timeout=1)
