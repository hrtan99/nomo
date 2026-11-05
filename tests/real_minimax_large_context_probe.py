#!/usr/bin/env python3
"""Exercise the real Nomo read chain near MiniMax's one-million-token window."""

import argparse
import json
import os
import random
import secrets
import shutil
import subprocess
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
            "payload_bytes": len(request_body["messages"][1]["content"].encode()),
            "max_tokens": request_body.get("max_tokens"),
            "seconds": time.monotonic() - started,
        }
        try:
            response_body = json.loads(body)
            record["usage"] = response_body.get("usage")
            record["finish_reason"] = response_body.get("choices", [{}])[0].get("finish_reason")
            if status >= 400:
                record["error"] = response_body.get("error", {}).get("message", "provider error")
        except (UnicodeDecodeError, json.JSONDecodeError):
            record["error"] = "non-JSON provider response"
        self.server.records.append(record)
        self.send_response(status)
        self.send_header("Content-Type", response_headers.get("Content-Type", "application/json"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def fixture_source():
    source = (ROOT / "tests/fixtures/chat_budget/large_input.es").read_text()
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~"
    base = "".join(random.Random(1048576).choices(alphabet, k=145))
    source = source.replace(
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
        "let result = run(" + json.dumps(TASK) + ', ["note.txt"], fresh_events().invocation, history, None(), None(), [], 0, false);',
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
    args = parser.parse_args()
    if not os.environ.get("MINIMAX_API_KEY"):
        raise SystemExit("MINIMAX_API_KEY is required")
    out = Path(tempfile.mkdtemp(prefix="nomo-real-minimax-1m-", dir=args.evidence_dir))
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), RecordingProxy)
    proxy.records = []
    proxy.entry_token = secrets.token_urlsafe(32)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    result = {"status": "running", "provider": "MiniMax China", "model": "MiniMax-M3.1-Flash", "evidence": str(out)}
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    try:
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
        main_calls = [item for item in proxy.records if item["max_tokens"] == 131072]
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
                      configured_prompt_plus_output_caps=[value + 131072 for value in prompt_tokens])
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
