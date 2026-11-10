#!/usr/bin/env python3
"""Exercise the real Nomo read chain near MiniMax's one-million-token window."""

import argparse
import json
import os
import random
import re
import secrets
import shutil
import subprocess
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TASK = "Read note.txt and report its exact content."
ANSWER = "NOMO_ONE_MILLION_CONTEXT_OK"


class RecordingProxy(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        prefix = "/" + self.server.entry_token
        if self.client_address[0] not in ("127.0.0.1", "::1") or not self.path.startswith(prefix + "/"):
            self.send_error(404)
            return
        started = time.monotonic()
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        request_body = json.loads(raw)
        headers = {
            "Authorization": "Bearer " + os.environ["MINIMAX_API_KEY"],
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
        }
        upstream = urllib.request.Request(
            "https://api.minimax.cn" + self.path[len(prefix):],
            data=raw,
            headers=headers,
            method="POST",
        )
        status = 502
        response_headers = {}
        try:
            with urllib.request.urlopen(upstream, timeout=1200) as response:
                status = response.status
                body = response.read()
                response_headers = dict(response.headers)
        except urllib.error.HTTPError as error:
            status = error.code
            body = error.read()
            response_headers = dict(error.headers)
        record = {
            "index": len(self.server.records),
            "status": status,
            "request_bytes": len(raw),
            "payload_bytes": sum(len(message["content"].encode()) for message in request_body["messages"] if message["role"] == "user"),
            "history_markers": sorted(set(re.findall(r"NOMO-PART-\d+-", raw.decode()))),
            "max_tokens": request_body.get("max_tokens"),
            "seconds": time.monotonic() - started,
        }
        try:
            response_body = json.loads(body)
            record["usage"] = response_body.get("usage")
            record["finish_reason"] = response_body.get("choices", [{}])[0].get("finish_reason")
            message = response_body.get("choices", [{}])[0].get("message", {})
            record["output"] = message.get("tool_calls") or message.get("content")
            if status >= 400:
                record["error"] = response_body.get("error", {}).get("message", "provider error")
        except (UnicodeDecodeError, json.JSONDecodeError):
            record["error"] = "non-JSON provider response"
        self.server.records.append(record)
        print(json.dumps({"request":record["index"], "status":status, "usage":record.get("usage"), "seconds":round(record["seconds"], 1)}), flush=True)
        self.send_response(status)
        self.send_header("Content-Type", response_headers.get("Content-Type", "application/json"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class PersistentProxy(RecordingProxy):
    def do_POST(self):
        if self.server.live:
            return super().do_POST()
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        turn, stage = divmod(self.server.seed_requests, 4)
        value = (["delegate", f"Read part{turn}.txt"] if stage == 0 else
                 ["read", f"part{turn}.txt"] if stage == 1 else
                 ["final", f"Captured NOMO-PART-{turn}-"] if stage == 2 else f"Captured NOMO-PART-{turn}-")
        content = json.dumps(value) if isinstance(value, list) else value
        message = {"role":"assistant", "content":content}; finish = "stop"
        if request.get("tools"):
            output = {"operation":value[0], "files":value[1:] if value[0] == "read" else [], "literal":"", "text":value[1] if value[0] == "final" else ""}
            message = {"role":"assistant", "content":None, "tool_calls":[{"id":"synthetic-output", "type":"function", "function":{"name":"etas_emit_output", "arguments":json.dumps(output)}}]}
            finish = "tool_calls"
        body = json.dumps({"choices":[{"message":message, "finish_reason":finish}],
                           "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}).encode()
        self.server.seed_requests += 1
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


def persisted_context(out, proxy, timeout):
    from real_minimax_workflow_probe import prepare_project
    project = prepare_project(out, proxy)
    workspace = out / "workspace"; workspace.mkdir(mode=0o700)
    (workspace / "note.txt").write_text(ANSWER)
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~"
    base = "".join(random.Random(1048576).choices(alphabet, k=167)).replace("%", "")
    for turn in range(4):
        (workspace / f"part{turn}.txt").write_text(f"NOMO-PART-{turn}-" + base * 2048)
    env = dict(os.environ, MINIMAX_API_KEY="SYNTHETIC_PROXY_ONLY", NOMO_STATE_DIR=str(out / "state"), NOMO_ETAS_VERSION="0.4.1")
    identifier = None
    for turn in range(5):
        name = f"part{turn}.txt" if turn < 4 else "note.txt"
        question = f"Read {name} completely and report its marker." if turn < 4 else TASK
        command = [str(project / "scripts/nomo"), "--legacy", "--root", str(workspace), "--allow", name, "--once", question]
        command += ["--high-input"] if identifier is None else ["--latest"]
        if turn == 4:
            assert proxy.seed_requests == 16
            proxy.live = True
        completed = subprocess.run(command, env=env, capture_output=True, timeout=timeout)
        (out / f"turn{turn}.stdout").write_bytes(completed.stdout)
        (out / f"turn{turn}.stderr").write_bytes(completed.stderr)
        assert completed.returncode == 0, completed.stderr[-2000:]
        if identifier is None:
            identifier = re.search(rb"SESSION ID ([0-9a-f]{32})", completed.stdout).group(1).decode()
        else:
            assert identifier.encode() in completed.stdout
        print(json.dumps({"persisted_turn":turn, "real_provider":turn == 4}), flush=True)
    assert ("FINAL " + ANSWER).encode() in completed.stdout
    main_calls = [record for record in proxy.records if record["max_tokens"] == 8192]
    prompt_tokens = [record["usage"]["prompt_tokens"] for record in main_calls]
    assert len(main_calls) == 2 and min(prompt_tokens) >= 950000
    assert all(record["history_markers"] == [f"NOMO-PART-{i}-" for i in range(4)] for record in main_calls)
    assert all(record["usage"]["prompt_tokens"] + record["max_tokens"] <= 1000000 for record in proxy.records)
    database = out / "state/sessions" / identifier / "history.sqlite3"
    with sqlite3.connect(database) as connection:
        assert connection.execute("pragma integrity_check").fetchone() == ("ok",)
        evidence_rows = connection.execute("select count(*) from memory_entries where region='nomo-recoverable-chat-evidence-v1'").fetchone()[0]
        assert evidence_rows == 4
    return {"status":"passed", "scope":"ordinary persisted session, five independent processes, final real MiniMax read chain", "session":identifier,
            "seed_requests":proxy.seed_requests, "calls":proxy.records, "large_prompt_tokens":prompt_tokens, "archived_evidence_rows":evidence_rows}


def continue_to_million(previous, out, proxy, timeout):
    from real_minimax_workflow_probe import prepare_project
    baseline = json.loads((previous / "result.json").read_text())
    assert baseline["status"] == "passed"
    project = prepare_project(out, proxy)
    workspace = previous / "workspace"
    # One further ordinary read fills the measured gap. No stored state or
    # model payload is edited, and no failed request is retried.
    padding_tokens = 1001500 - max(baseline["large_prompt_tokens"]) - 500
    (workspace / "part4.txt").write_text("NOMO-PART-4-" + "a " * padding_tokens)
    env = dict(os.environ, MINIMAX_API_KEY="SYNTHETIC_PROXY_ONLY", NOMO_STATE_DIR=str(previous / "state"), NOMO_ETAS_VERSION="0.4.1")
    proxy.seed_requests = 16
    for index, name, question in ((0, "part4.txt", "Read part4.txt completely and report its marker."), (1, "note.txt", TASK)):
        if index == 1: proxy.live = True
        completed = subprocess.run([str(project / "scripts/nomo"), "--legacy", "--root", str(workspace), "--latest", "--allow", name, "--once", question],
                                   env=env, capture_output=True, timeout=timeout)
        (out / f"extension{index}.stdout").write_bytes(completed.stdout)
        (out / f"extension{index}.stderr").write_bytes(completed.stderr)
        assert completed.returncode == 0, completed.stderr[-2000:]
        assert baseline["session"].encode() in completed.stdout
    assert ("FINAL " + ANSWER).encode() in completed.stdout
    main_calls = [record for record in proxy.records if record["max_tokens"] == 8192]
    prompt_tokens = [record["usage"]["prompt_tokens"] for record in main_calls]
    assert len(main_calls) == 2 and min(prompt_tokens) >= 1000000
    assert all(record["history_markers"] == [f"NOMO-PART-{i}-" for i in range(5)] for record in main_calls)
    return {"status":"passed", "scope":"ordinary session extended through two further processes; at least one million actual input tokens",
            "session":baseline["session"], "previous_evidence":str(previous), "calls":proxy.records, "large_prompt_tokens":prompt_tokens,
            "prompt_plus_output_reservations":[record["usage"]["prompt_tokens"] + record["max_tokens"] for record in main_calls]}


def fixture_source():
    source = (ROOT / "tests/fixtures/chat_budget/large_input.es").read_text()
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~"
    base = "".join(random.Random(1048576).choices(alphabet, k=145))
    source = source.replace(
        "import nomo.session.chat_session_contract.fresh_events;",
        "import nomo.session.chat_session_contract.fresh_high_input_events;",
    ).replace(
        'var text = "0123456789abcdef0123456789abcdef";',
        "var text = " + json.dumps(base) + ";",
    ).replace(
        "while i < 13 limit Iterations(13)",
        "while i < 11 limit Iterations(11)",
    ).replace(
        'text = "Read the task"',
        "text = " + json.dumps(TASK),
    ).replace(
        "let history = [task, item, item, item, item, item];",
        "let history = [task, item, item, item, item];",
    ).replace(
        "[EventPolicy.Task, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required]",
        "[EventPolicy.Task, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required]",
    ).replace(
        'let result = run("Read the task", ["note.txt"], fresh_events().invocation, history, None(), None(), [], 0, false);',
        "let result = run(" + json.dumps(TASK) + ', ["note.txt"], fresh_high_input_events().invocation, history, None(), None(), [], 0, false);',
    )
    if "while i < 11" not in source or "item, item, item, item]" not in source:
        raise AssertionError("large-input fixture rewrite did not apply")
    return source


def copy_tracked_project(project):
    project.mkdir()
    listed = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True).stdout
    for raw in listed.split(b"\0"):
        if not raw:
            continue
        relative = Path(os.fsdecode(raw))
        source = ROOT / relative
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            target.symlink_to(os.readlink(source))
        elif source.is_file():
            shutil.copy2(source, target)
    # Exercise current runtime additions before they have been staged by PM.
    for name in ('src', 'scripts'):
        shutil.copytree(ROOT / name, project / name, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))


def prepare(out, port, entry_token):
    project = out / "project"
    copy_tracked_project(project)
    (project / ".etas").mkdir()
    (project / "src/app").mkdir()
    (project / "src/app/large_input.es").write_text(fixture_source())
    entry = project / "src/nomo/main.es"
    entry.write_text(
        entry.read_text().replace("module nomo.main;", "module nomo.main;\nimport app.large_input.probe as large_input_probe;")
        + "\npublic flow probe(args: Array<string>) -> i32 { return large_input_probe(args); }\n"
    )
    workspace = out / "workspace"
    workspace.mkdir(mode=0o755)
    (workspace / "note.txt").write_text(ANSWER)
    manifest = project / "etas.toml"
    value = manifest.read_text()
    value = value.replace(
        '[runtime.profiles.nomo-read-events-new.memory]\nbackend = "sqlite"\npath = "history.sqlite3"',
        '[runtime.profiles.nomo-read-events-new.memory]\nbackend = "sqlite"\npath = "/tmp/history.sqlite3"',
    )
    start = value.index("[runtime.profiles.nomo-read-events-new.model]")
    end = value.index("[runtime.profiles.nomo-read-events-new.model.timeout]", start)
    model = value[start:end].replace("https://api.minimax.cn/v1", f"http://host.docker.internal:{port}/{entry_token}/v1")
    value = value[:start] + model.replace("allow_private = false", "allow_private = true") + value[end:]
    value = value.replace(
        '[runtime.profiles.nomo-read-events-new.filesystem.regions."nomo.session.event_policy.PolicyRoot"]\nroot = "/tmp/nomo-event-policy"\nread = true\nwrite = false\n',
        "",
    )
    manifest.write_text(value)
    override = out / "compose.yaml"
    override.write_text(
        """services:
  dev:
    network_mode: bridge
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - type: bind
        source: %s
        target: /model-tool-fixture
        read_only: true
""" % json.dumps(str(workspace))
    )
    return project, override


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-dir", type=Path, default=Path("/private/tmp"))
    parser.add_argument("--timeout", type=int, default=2400)
    parser.add_argument("--credential-file", type=Path)
    parser.add_argument("--persisted", action="store_true", help="build history through four ordinary local-provider read turns, then restore it into real MiniMax")
    parser.add_argument("--continue-from", type=Path, help="append one synthetic read to a passed persisted run and measure one million actual input tokens")
    args = parser.parse_args()
    if args.credential_file:
        os.environ["MINIMAX_API_KEY"] = args.credential_file.read_text().strip()
    if not os.environ.get("MINIMAX_API_KEY"):
        raise SystemExit("MINIMAX_API_KEY is required")
    out = Path(tempfile.mkdtemp(prefix="nomo-real-minimax-1m-", dir=args.evidence_dir))
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), PersistentProxy if args.persisted or args.continue_from else RecordingProxy)
    proxy.records = []
    proxy.live = False
    proxy.seed_requests = 0
    proxy.entry_token = secrets.token_urlsafe(32)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    result = {"status": "running", "provider": "MiniMax China", "model": "MiniMax-M3.1-Flash", "evidence": str(out)}
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    try:
        if args.continue_from:
            result.update(continue_to_million(args.continue_from, out, proxy, args.timeout))
            return
        if args.persisted:
            result.update(persisted_context(out, proxy, args.timeout))
            return
        project, override = prepare(out, proxy.server_port, proxy.entry_token)
        docker = "/Applications/Docker.app/Contents/Resources/bin/docker"
        command = [
            docker, "compose", "--env-file", "/dev/null", "-f", str(project / "compose.yaml"),
            "-f", str(project / "config/etas-041-official-compose.yaml"),
            "-f", str(project / "config/etas-runtime-cache-compose.yaml"), "-f", str(override),
            "run", "--rm", "--no-deps", "-T", "dev", "python3", "-B",
            "/workspace/scripts/nomo-verified-etas.py", "run", "/workspace", "--flow", "probe",
            "--profile", "nomo-read-events-new", "--allow-effects",
        ]
        env = dict(os.environ, NOMO_ETAS_GRAPH="latest041")
        completed = subprocess.run(command, cwd=project, env=env, capture_output=True, text=True, timeout=args.timeout)
        (out / "stdout.log").write_text(completed.stdout)
        (out / "stderr.log").write_text(completed.stderr)
        main_calls = [item for item in proxy.records if item["max_tokens"] == 8192]
        prompt_tokens = [(item.get("usage") or {}).get("prompt_tokens") for item in main_calls]
        if completed.returncode or "PASS large input" not in completed.stdout or ("FINAL " + ANSWER) not in completed.stdout.splitlines():
            raise AssertionError("Nomo large-context flow failed")
        if len(main_calls) != 2 or any(value is None for value in prompt_tokens):
            raise AssertionError("provider did not report both large main calls")
        if min(prompt_tokens) < 850000:
            raise AssertionError("provider-reported input did not reach the calibrated large-context range")
        if max(item["usage"]["total_tokens"] for item in main_calls) > 1000000:
            raise AssertionError("provider-reported total usage exceeded the one-million-token window")
        result.update(status="passed", calls=proxy.records, large_prompt_tokens=prompt_tokens,
                      configured_prompt_plus_output_caps=[value + 8192 for value in prompt_tokens])
    except BaseException as error:
        result.update(status="failed", failure_type=type(error).__name__, failure=str(error), calls=proxy.records)
        raise
    finally:
        (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        proxy.shutdown()
        proxy.server_close()
        thread.join(timeout=5)
        print(json.dumps({"status": result["status"], "evidence": str(out)}), flush=True)


if __name__ == "__main__":
    main()
