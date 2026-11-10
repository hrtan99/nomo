#!/usr/bin/env python3
"""Run the release read/edit/check/resume path against MiniMax using synthetic files."""
import argparse
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import signal
import sqlite3
import subprocess
import tempfile
import termios
import threading
import time
from http.server import ThreadingHTTPServer

from real_minimax_large_context_probe import RecordingProxy, copy_tracked_project

ROOT = Path(__file__).resolve().parent.parent
BEFORE = 'COLOR = "old"\n'
AFTER = 'COLOR = "new"\n'


def prepare_project(out, proxy):
    project = out / "project"
    copy_tracked_project(project)
    (project / ".etas").mkdir()
    manifest = project / "etas.toml"
    text = manifest.read_text()
    for name in ("nomo-read-events-new", "nomo-read-events-existing", "nomo-history-events-work"):
        start = text.index("[runtime.profiles." + name + ".model]")
        end = text.index("[runtime.profiles." + name + ".model.timeout]", start)
        model = text[start:end].replace("https://api.minimax.cn/v1", f"http://host.docker.internal:{proxy.server_port}/{proxy.entry_token}/v1")
        text = text[:start] + model.replace("allow_private = false", "allow_private = true") + text[end:]
    manifest.write_text(text)
    return project


def interact(command, env, out):
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    settings[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    process = subprocess.Popen(command, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    step = 0
    native = application = False
    deadline = time.monotonic() + 900
    try:
        while process.poll() is None:
            if time.monotonic() > deadline:
                raise TimeoutError("real workflow stopped at step " + str(step))
            if select.select([master], [], [], .1)[0]:
                try: output.extend(os.read(master, 65536))
                except OSError: pass
            view = bytes(output)
            if b"Abandon this stopped operation and continue this session?" in view:
                raise AssertionError("work stopped; retained terminal log identifies the failed stage")
            if step == 0 and b"nomo> " in view:
                os.write(master, b"Locate the COLOR setting and explain its current value with the file path.\n")
                step = 1
            elif step == 1 and view.count(b"nomo> ") >= 2:
                assert b"settings.py" in view and b"old" in view
                os.write(master, b"Change COLOR from old to new in settings.py.\n")
                step = 2
            if step == 2 and not native and b"Type `yes` to approve:" in view:
                previews = [json.loads(line[8:]) for line in view.splitlines() if line.startswith(b"PREVIEW ")]
                assert len(previews) == 1 and previews[0]["path"] == "settings.py"
                assert previews[0]["before"] == BEFORE and previews[0]["after"] == AFTER
                os.write(master, b"yes\n")
                native = True
            if step == 2 and not application and b"CONFIRM Apply this exact preview? [y/N]" in view:
                assert native
                os.write(master, b"yes\n")
                application = True
            if step == 2 and b"Check recorded. Reviewing its result against the original request." in view:
                step = 3
            elif step == 3 and view.count(b"nomo> ") >= 3:
                os.write(master, b"Explain the completed change and the recorded check result. Do not edit or run another check.\n")
                step = 4
            elif step == 4 and view.count(b"nomo> ") >= 4:
                os.write(master, b"/exit\n")
                step = 5
        while select.select([master], [], [], 0)[0]:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            output.extend(data)
        assert process.returncode == 0 and step == 5 and native and application, bytes(output)[-3000:]
        assert b"Check passed." in output and output.count(b"PREVIEW ") == 1
        return bytes(output)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=25)
        os.close(master)
        (out / "terminal.log").write_bytes(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--credential-file", type=Path, required=True)
    args = parser.parse_args()
    os.environ["MINIMAX_API_KEY"] = args.credential_file.read_text().strip()
    out = Path(tempfile.mkdtemp(prefix="nomo-real-release-", dir="/private/tmp"))
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), RecordingProxy)
    proxy.records = []
    proxy.entry_token = secrets.token_urlsafe(32)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    result = {"status": "running", "evidence": str(out)}
    try:
        project = prepare_project(out, proxy)
        workspace = out / "workspace"
        workspace.mkdir(mode=0o700)
        (workspace / "settings.py").write_text(BEFORE)
        (workspace / "README.txt").write_text("The application color is the COLOR setting in settings.py.\n")
        env = dict(os.environ, MINIMAX_API_KEY="SYNTHETIC_PROXY_ONLY", NOMO_STATE_DIR=str(out / "state"), NOMO_ETAS_VERSION="0.4.1")
        command = [str(project / "scripts/nomo"), "--root", str(workspace), "--high-input", "--check", "python3", "-c", 'from settings import COLOR; assert COLOR == "new"; print("COLOR_CHECK_OK")']
        output = interact(command, env, out)
        identifier = re.search(rb"SESSION ID ([0-9a-f]{32})", output).group(1).decode()
        assert (workspace / "settings.py").read_text() == AFTER
        resumed = subprocess.run([str(project / "scripts/nomo"), "--root", str(workspace), "--latest", "--once", "Report the previous COLOR change and its recorded check result. Do not modify files or run a check."], env=env, capture_output=True, timeout=300)
        (out / "resumed.stdout").write_bytes(resumed.stdout)
        (out / "resumed.stderr").write_bytes(resumed.stderr)
        assert resumed.returncode == 0 and identifier.encode() in resumed.stdout
        assert b"FINAL " in resumed.stdout and b"new" in resumed.stdout and b"PREVIEW " not in resumed.stdout
        assert (workspace / "settings.py").read_text() == AFTER
        status = subprocess.run([str(project / "scripts/nomo"), "--id", identifier, "--status", "--events"], env=env, capture_output=True, timeout=180)
        (out / "status.log").write_bytes(status.stdout + status.stderr)
        assert status.returncode == 0 and b"work-boundary" in status.stdout and b"work-check" in status.stdout
        assert status.stdout.index(b"work-boundary") < status.stdout.index(b"work-check")
        database = out / "state/sessions" / identifier / "history.sqlite3"
        with sqlite3.connect(database) as connection:
            assert connection.execute("pragma integrity_check").fetchone() == ("ok",)
        assert (workspace / "settings.py").read_text() == AFTER and b"COLOR_CHECK_OK" in status.stdout
        assert all(record["status"] == 200 and record.get("usage") for record in proxy.records)
        result.update(status="passed", session=identifier, calls=proxy.records, approved_edits=1, check="COLOR_CHECK_OK", latest_resume=True, non_tty=True)
    except BaseException as error:
        result.update(status="failed", error=repr(error), calls=proxy.records)
        raise
    finally:
        (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        proxy.shutdown(); proxy.server_close(); thread.join(timeout=5)
        print(json.dumps({"status":result["status"], "evidence":str(out)}), flush=True)


if __name__ == "__main__":
    main()
