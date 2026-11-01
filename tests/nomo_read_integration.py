#!/usr/bin/env python3
"""Exercise the actual read launcher using only an owned synthetic model and files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from read_container_identity import inspect_launch, container_absent

ROOT = Path(__file__).resolve().parent.parent
TOKEN = 'SYNTHETIC_READ_INTEGRATION_TOKEN'


def source_fingerprint():
    digest = hashlib.sha256()
    for path in sorted((ROOT / 'src').rglob('*.es')):
        digest.update(str(path.relative_to(ROOT)).encode() + b'\0')
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', type=Path)
    options = parser.parse_args()
    evidence = None
    if options.evidence_dir:
        options.evidence_dir.mkdir(parents=True, exist_ok=True)
        evidence = Path(tempfile.mkdtemp(prefix='nomo-read-fake-', dir=options.evidence_dir))
    counts = {'started': 0, 'completed': 0, 'valid_context': True}
    inspection = {}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            counts['started'] += 1
            try:
                if counts['started'] == 1:
                    inspection.update(inspect_launch(ROOT, read_root))
                assert counts['started'] <= 4 and self.path == '/v1/chat/completions'
                assert self.headers.get('Authorization') == 'Bearer ' + TOKEN
                length = int(self.headers['Content-Length'])
                assert 0 < length <= 196608
                request = json.loads(self.rfile.read(length))
                context = json.loads(request['messages'][1]['content'])
                assert context['allowed'] == ['docs/a.txt']
                task = '请读取文件并报告颜色。'
                if counts['started'] == 1:
                    assert context['phase'] == 'plan'
                    text = json.dumps(['delegate', task], ensure_ascii=False)
                elif counts['started'] == 2:
                    assert context['final_only'] is False
                    text = json.dumps(['read', 'docs/a.txt'])
                elif counts['started'] == 3:
                    assert context['final_only'] is True and '蓝色' in context['history'][-1]['text']
                    text = json.dumps(['final', '内容是蓝色。'], ensure_ascii=False)
                else:
                    assert context['phase'] == 'aggregate' and '蓝色' in context['outcome']
                    text = '验证颜色是蓝色。'
                body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                                   'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                counts['completed'] += 1
            except Exception:
                counts['valid_context'] = False
                self.send_error(400)
    server = HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    proc = None
    source_before = source_fingerprint()
    result = {'status': 'failed', 'scope': 'actual launcher; synthetic file and local fake model; no real provider',
              'inputs': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
                         ('scripts/nomo-read.sh', 'scripts/nomo-verified-etas.py', 'config/read-chat-compose.yaml',
                          'config/etas-022-official-compose.yaml', 'config/etas-022-official.json',
                          'config/etas-022-official.Cargo.lock', 'tests/read_container_identity.py', 'tests/nomo_read_integration.py')}}
    try:
        with tempfile.TemporaryDirectory(prefix='nomo-read-fixture-') as tmp:
            read_root = Path(tmp) / 'context'
            (read_root / 'docs').mkdir(parents=True)
            (read_root / 'docs/a.txt').write_text('合成验证颜色：蓝色。\n')
            env = dict(os.environ, NOMO_READ_MODEL_BASE_URL=f'http://host.docker.internal:{server.server_port}/v1',
                       NOMO_READ_MODEL_NAME='synthetic-model', NOMO_QWEN_SERVER_API_KEY=TOKEN)
            result['configured_runtime'] = {'selector': 'latest022'}
            result['source_sha256'] = source_before
            cmd = [str(ROOT / 'scripts/nomo-read.sh'), 'ask', '--root', str(read_root), '--allow', 'docs/a.txt',
                   '--once', '请读取文件并说明验证颜色。']
            proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                stdout, stderr = proc.communicate(timeout=120)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.communicate(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.communicate(timeout=5)
                raise
            assert proc.returncode == 0, (proc.returncode, stderr.decode(errors='replace'))
            assert any(line.startswith(b'FINAL ') and '蓝色'.encode() in line for line in stdout.splitlines())
            assert counts == {'started': 4, 'completed': 4, 'valid_context': True}, counts
            assert (read_root / 'docs/a.txt').read_text() == '合成验证颜色：蓝色。\n'
            assert source_fingerprint() == source_before
            assert inspection and container_absent(inspection['container_id'])
            result['container_identity'] = inspection
            result['container_absent'] = True
        print('PASS actual launcher, read-only synthetic file and four-stage local model')
        result.update(status='passed', exit=proc.returncode, calls=counts.copy(), final_contains_synthetic_value=True,
                      synthetic_file_unchanged=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert proc is None or proc.poll() is not None
        result.update(server_stopped=not thread.is_alive(), launcher_stopped=proc is None or proc.poll() is not None)
        if evidence:
            (evidence / 'result.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')


if __name__ == '__main__':
    main()
