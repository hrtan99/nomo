#!/usr/bin/env python3
"""Exercise input cancellation and model-wait cleanup through the public terminal."""
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from real_minimax_workflow_probe import prepare_project
from read_session_interrupt_probe import container_absent


class WaitingModel(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.server.started.set()
        self.server.release.wait(60)
        try:
            self.send_response(503); self.send_header("Content-Length", "0"); self.end_headers()
        except (BrokenPipeError, ConnectionResetError): pass


def terminal(command, env, started=None, eof=False):
    master, slave = pty.openpty()
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    output = bytearray(); submitted = cancelled = False
    deadline = time.monotonic() + 180
    try:
        while process.poll() is None:
            if time.monotonic() > deadline: raise TimeoutError("terminal cancellation did not finish")
            if select.select([master], [], [], .1)[0]:
                try: output.extend(os.read(master, 65536))
                except OSError: pass
            if not submitted and b"nomo> " in output:
                if started is not None: os.write(master, b"Read settings.py\n")
                elif eof: os.write(master, b"\x04")
                else: os.kill(process.pid, signal.SIGINT)
                submitted = True
            if started is not None and started.is_set() and not cancelled:
                os.kill(process.pid, signal.SIGINT); cancelled = True
        while select.select([master], [], [], 0)[0]:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            output.extend(data)
        assert process.returncode == (0 if eof else 130), bytes(output)[-2000:]
        return bytes(output)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM); process.wait(timeout=25)
        os.close(master)


def main():
    out = Path(tempfile.mkdtemp(prefix="nomo-terminal-release-", dir="/private/tmp"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), WaitingModel)
    server.entry_token = "synthetic"; server.started = threading.Event(); server.release = threading.Event()
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        project = prepare_project(out, server)
        workspace = out / "workspace"; workspace.mkdir(mode=0o700)
        (workspace / "settings.py").write_text('COLOR = "old"\n')
        env = dict(os.environ, MINIMAX_API_KEY="SYNTHETIC_ONLY", NOMO_STATE_DIR=str(out / "state"))
        command = [str(project / "scripts/nomo"), "--root", str(workspace), "--allow", "settings.py", "--high-input"]
        for name, started, eof in (("input", None, False), ("eof", None, True), ("model", server.started, False)):
            output = terminal(command, env, started, eof)
            (out / (name + ".log")).write_bytes(output)
        assert container_absent(workspace)
        identifier = re.search(rb"SESSION ID ([0-9a-f]{32})", output).group(1).decode()
        with sqlite3.connect(out / "state/sessions" / identifier / "history.sqlite3") as connection:
            frame = connection.execute("select value_json from memory_entries where region='nomo-recoverable-chat-v1'").fetchone()[0]
            assert '"running"' in frame
        result = {"status":"passed", "input_sigint":130, "model_sigint":130, "eof":0, "owned_container_absent":True, "running_reservation_preserved":True}
        (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(dict(result, evidence=str(out))))
    finally:
        server.release.set(); server.shutdown(); server.server_close(); thread.join(timeout=5)


if __name__ == "__main__": main()
