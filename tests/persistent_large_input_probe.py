#!/usr/bin/env python3
"""Carry >1 MiB of actual persisted reads into a later top-level Nomo request."""
import json, os, random, re, shutil, sqlite3, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TURNS = 5
FILE_BYTES = 262144


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            index = len(self.server.requests); turn, stage = divmod(index, 4)
            assert turn < TURNS and request['max_tokens'] == (8192, 16384, 16384, 8192)[stage]
            payload = request['messages'][1]['content']; payload_bytes = len(payload.encode())
            if turn == TURNS - 1 and stage in (0, 3):
                assert payload_bytes > 1048576, payload_bytes
                for prior in range(TURNS - 1): assert 'NOMO-PART-%d-' % prior in payload
                self.server.large_requests.append(payload_bytes)
            if stage == 2: assert 'NOMO-PART-%d-' % turn in payload
            value = (['delegate', 'Read part%d.txt' % turn] if stage == 0 else
                     ['read', 'part%d.txt' % turn] if stage == 1 else
                     ['final', 'captured part %d' % turn] if stage == 2 else
                     'captured part %d' % turn)
            content = json.dumps(value, separators=(',', ':')) if isinstance(value, list) else value
            data = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': content},
                                            'finish_reason': 'stop'}],
                               'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode()
            self.server.requests.append({'turn': turn, 'stage': stage, 'payload_bytes': payload_bytes,
                                         'max_tokens': request['max_tokens']})
            self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        except Exception as error:
            self.server.error = repr(error)
            try: self.send_error(500)
            except OSError: pass


def copy_project(target):
    target.mkdir()
    listed = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, check=True, capture_output=True).stdout
    for raw in listed.split(b'\0'):
        if not raw: continue
        relative = Path(os.fsdecode(raw)); source = ROOT / relative; destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source, destination)


def fixture(turn):
    marker = 'NOMO-PART-%d-' % turn
    alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~'
    random_text = ''.join(random.Random(1048576 + turn).choices(alphabet, k=FILE_BYTES - len(marker)))
    return marker + random_text


def main():
    out = Path(tempfile.mkdtemp(prefix='nomo-persistent-large-input-', dir='/private/tmp'))
    project = out / 'project'; copy_project(project)
    workspace = out / 'workspace'; workspace.mkdir(mode=0o700)
    for turn in range(TURNS):
        value = fixture(turn); assert len(value.encode()) == FILE_BYTES; (workspace / ('part%d.txt' % turn)).write_text(value)
    state = out / 'state'
    server = HTTPServer(('127.0.0.1', 0), Fake); server.requests = []; server.large_requests = []; server.error = None
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    manifest = project / 'etas.toml'; text = manifest.read_text()
    for name in ('nomo-read-events-new', 'nomo-read-events-existing'):
        start = text.index('[runtime.profiles.' + name + '.model]'); end = text.index('[runtime.profiles.' + name + '.model.timeout]', start)
        block = text[start:end].replace('https://api.minimax.cn/v1', 'http://host.docker.internal:%d/v1' % server.server_port).replace('allow_private = false', 'allow_private = true')
        text = text[:start] + block + text[end:]
    manifest.write_text(text)
    env = dict(os.environ, MINIMAX_API_KEY='SYNTHETIC_ONLY', NOMO_STATE_DIR=str(state),
               NOMO_ETAS_VERSION='0.4.1', NOMO_ETAS_GRAPH='latest041')
    identifier = None; runs = []
    try:
        for turn in range(TURNS):
            command = [str(project / 'scripts/nomo'), '--root', str(workspace), '--allow', 'part%d.txt' % turn,
                       '--once', 'Read part %d' % turn]
            if identifier is None: command.append('--high-input')
            else: command += ['--id', identifier]
            completed = subprocess.run(command, env=env, capture_output=True, timeout=300)
            (out / ('turn%d.stdout' % turn)).write_bytes(completed.stdout); (out / ('turn%d.stderr' % turn)).write_bytes(completed.stderr)
            assert completed.returncode == 0, (turn, completed.stderr[-3000:])
            if identifier is None:
                ids = re.findall(rb'^SESSION ID ([0-9a-f]{32})$', completed.stdout, re.M); assert len(ids) == 1
                identifier = ids[0].decode()
            assert ('FINAL captured part %d' % turn).encode() in completed.stdout
            runs.append({'turn': turn, 'stdout_bytes': len(completed.stdout), 'stderr_bytes': len(completed.stderr)})
        assert len(server.requests) == TURNS * 4 and len(server.large_requests) == 2 and server.error is None
        session = state / 'sessions' / identifier; database = session / 'history.sqlite3'
        with sqlite3.connect(database) as connection:
            assert connection.execute('pragma integrity_check').fetchone() == ('ok',)
            archived = connection.execute("select count(*) from memory_entries where region='nomo-recoverable-chat-evidence-v1'").fetchone()[0]
            assert archived >= TURNS - 1, archived
            main_json = connection.execute("select value_json from memory_entries where region='nomo-recoverable-chat-v1'").fetchone()[0]
            main_bytes = len(main_json.encode())
            large_main_strings = connection.execute(
                "select count(*) from memory_entries,json_tree(value_json) where region='nomo-recoverable-chat-v1' "
                "and json_tree.key='value' and json_tree.type='text' and length(json_tree.value)>131072").fetchone()[0]
            assert main_bytes < 1048576, main_bytes
            assert large_main_strings == 1, large_main_strings
            assert main_json.count('Large prior tool outcome retained by canonical turn evidence') >= TURNS - 1
        result = {'status': 'passed', 'scope': 'actual persisted bytes through local synthetic provider; no real tokenizer or provider usage',
                  'turns': TURNS, 'processes': TURNS, 'actual_read_bytes': TURNS * FILE_BYTES,
                  'later_payload_bytes': server.large_requests, 'archived_evidence_rows': archived,
                  'main_frame_bytes': main_bytes, 'large_main_strings': large_main_strings,
                  'requests': server.requests, 'runs': runs, 'evidence': str(out)}
    except BaseException as error:
        result = {'status': 'failed', 'failure': repr(error), 'server_error': server.error,
                  'requests': server.requests, 'large_requests': server.large_requests, 'runs': runs, 'evidence': str(out)}
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)
    (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n'); print(json.dumps(result))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__': raise SystemExit(main())
