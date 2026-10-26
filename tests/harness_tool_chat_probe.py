#!/usr/bin/env python3
"""Actual bounded two-turn Model/File chat through pipes and genuine PTYs.

This runner supplies protocol replies and retains observations. It does not run
Nomo policy in Python and never dispatches before the fixture protocol freezes.
"""
import argparse
import base64
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import harness_tool_probe as once
import harness_chat_probe as terminal

FIXTURE = ROOT / "tests/fixtures/harness_tool002a/cases.py"
specification = once.load("bounded_tool_chat_cases", FIXTURE)
terminal.FIXTURE = FIXTURE  # Configure the unchanged PTY helper's banner source.
PORT, REFUSED_PORT = 18863, 18864
MEMORY_LIMIT = once.MEMORY_LIMIT
digest, save, retain = once.digest, once.save, once.retain
resources, pressure, snapshot = once.resources, once.pressure, once.snapshot
encoded, event = once.encoded, once.event


def product_paths():
    sources = sorted((ROOT / "src").rglob("*.es"))
    if len(sources) != 54 or any(path.name.startswith("model_session") for path in sources):
        raise ValueError("the complete isolated recursive tool-chat product is required")
    return sources + [ROOT / "etas.toml", ROOT / "etas.lock"]


def hashes(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def manifest(item, fixture_root):
    return once.manifest(item, fixture_root).replace("127.0.0.1:" + str(once.PORT), "127.0.0.1:" + str(PORT)).replace(
        "127.0.0.1:" + str(once.REFUSED_PORT), "127.0.0.1:" + str(REFUSED_PORT))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(size) if 0 < size <= 32768 else b""
        record = {"path": self.path, "headers": dict(self.headers), "request_base64": base64.b64encode(raw).decode("ascii"),
                  "received_utc": datetime.now(timezone.utc).isoformat(), "received_monotonic": time.monotonic(), "finished": threading.Event()}
        with self.server.lock:
            self.server.records.append(record)
        try:
            request = json.loads(raw)
            context = json.loads(request["messages"][1]["content"])
            current = once.phase(context)
            if current == "plan":
                self.server.turn += 1
            index = self.server.turn
            if not 0 <= index < len(self.server.item["turns"]):
                raise ValueError("unexpected new turn, retry or replay")
            item = self.server.item["turns"][index]
            record.update(request=request, context=context, phase=current, turn=index + 1)
            if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + specification.TOKEN:
                raise ValueError("unexpected loopback path or authentication")
            text = specification.reply(item, context)
            mode = item.get("fail_mode", "ok") if item.get("fail_phase") == current else "ok"
            if mode == "empty":
                text = ""
            status = 200
            body = {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}
            if mode == "unavailable":
                status, body = 503, {"error": {"message": "bounded tool-chat fixture unavailable"}}
            elif mode == "missing_usage":
                del body["usage"]
            elif mode == "token_overrun":
                body["usage"] = {"prompt_tokens": 2048, "completion_tokens": 1, "total_tokens": 2049}
            data = b"not-json" if mode == "malformed" else encoded(body).encode("ascii")
            record.update(response_status=status, response_text=text, response_base64=base64.b64encode(data).decode("ascii"), fixture_mode=mode)
            if mode == "timeout":
                record["deliberate_delay_seconds"] = 0.85
                threading.Event().wait(0.85)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
                record["response_write"] = "completed"
            except (BrokenPipeError, ConnectionResetError):
                record["response_write"] = "client already aborted"
        except Exception as error:
            record["observer_error"] = type(error).__name__ + ": " + str(error)
            try:
                self.send_error(500, "fixture observation failed")
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            record["finished_utc"] = datetime.now(timezone.utc).isoformat()
            record["finished"].set()


def run_chat(argv, item, timeout):
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.item, server.records, server.turn, server.lock = item, [], -1, threading.Lock()
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    reserved = None
    if item["profile_mode"] == "connection":
        reserved = socket.socket()
        reserved.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        reserved.bind(("127.0.0.1", REFUSED_PORT))
    previous_token = os.environ.get("NOMO_HARNESS_TOOL_TEST_KEY")
    os.environ["NOMO_HARNESS_TOOL_TEST_KEY"] = specification.TOKEN
    thread.start()
    try:
        if item["transport"] == "pty":
            output = terminal.run_pty(argv, item, timeout)
        else:
            output = terminal.run_pipe(argv, item["stdin"].encode("utf-8"), timeout)
        returned = time.monotonic()
    finally:
        server.shutdown()
        thread.join(timeout=2)
        for record in server.records:
            record["finished"].wait(2)
        server.server_close()
        if reserved is not None:
            reserved.close()
        if previous_token is None:
            os.environ.pop("NOMO_HARNESS_TOOL_TEST_KEY", None)
        else:
            os.environ["NOMO_HARNESS_TOOL_TEST_KEY"] = previous_token
    records = [{key: value for key, value in record.items() if key != "finished"} for record in server.records]
    if records:
        records[-1]["process_returned_after_request_seconds"] = returned - records[-1]["received_monotonic"]
    return (*output, records)


def validate(item, stdout, stderr, code, trace, records, timed_out=False, proof=None, pty_failure=None):
    specification.configured()
    assert not timed_out and not pty_failure, "actual pipe/PTY failed"
    assert code == item["expected_exit"], "true process exit changed"
    assert stdout == specification.expected_stdout(item).encode(), "exact chat transcript changed"
    assert specification.TOKEN.encode() not in stdout + stderr
    contexts = specification.assert_http(item, records)
    observed = specification.assert_trace(item, trace, records)
    if proof is not None:
        assert proof["proc_child_descriptors_observed"] and proof["child_descriptors"]["0"]["isatty"] and proof["child_descriptors"]["1"]["isatty"]
        assert not proof["child_descriptors"]["2"]["isatty"] and not proof["echo"] and not proof["onlcr"]
    if any(turn["kind"] == "host_abort" for turn in item["turns"]):
        assert stderr and specification.WRAPPER.encode() not in stderr, "Host abort claimed a caught entry refusal"
    elif code:
        assert b"analysis::ExecutionAborted" in stderr and specification.WRAPPER.encode() in stderr
    else:
        assert not stderr, "successful chat wrote stderr"
    return {**contexts, **observed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--etas")
    parser.add_argument("--fixture-root", type=Path, default=Path("/harness-tool-fixture"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    options = parser.parse_args()
    if not 1 <= options.timeout <= 240 or not options.fixture_root.is_absolute():
        parser.error("bounded timeout and absolute read-only fixture root required")
    if not options.prepare_only and (not options.etas or not Path(options.etas).is_absolute()):
        parser.error("actual execution requires the selected absolute CLI")
    if not options.prepare_only:
        specification.configured()
    paths, cases = product_paths(), specification.cases()
    if any("\0" in value for item in cases for value in item["args"]):
        raise ValueError("NUL is valid stdin test data, never OS argv")
    runner_paths = [Path(__file__).resolve(), FIXTURE, ROOT / "tests/harness_tool_probe.py", ROOT / "tests/harness_chat_probe.py",
                    ROOT / "tests/harness_model_probe.py", ROOT / "tests/harness_entry_probe.py", ROOT / "tests/model_tool_probe.py",
                    ROOT / "tests/foundation_probe.py", ROOT / "tests/normal_graph_identity.py", ROOT / "tests/fixtures/harness_tool001/cases.py",
                    ROOT / "tests/fixtures/harness_model001/cases.py", once.previous.graph_identity.bootstrap_path(), ROOT / "config/etas-latest-main.json"]
    runner_paths += sorted(path for path in (once.FIXTURE / "workspace").rglob("*") if path.is_file())
    frozen_product, frozen_runner = hashes(paths), hashes(runner_paths)
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == path or path in destination.parents for path in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("raw evidence must be persistent")
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness-tool002a-", dir=destination))
    for source in paths + runner_paths:
        retain(source, evidence / "frozen-inputs" / source.relative_to(ROOT))
    save(evidence / "cases.json", cases)
    result = {"task": "HARNESS-TOOL-002A", "status": "not_run", "prepared_only": options.prepare_only,
              "created_utc": datetime.now(timezone.utc).isoformat(), "case_count": len(cases), "product_root": str(ROOT),
              "scope": "actual complete-root chat, pipe and PTY; unchanged one-shot/model cases remain separate",
              "protocol_ready": specification.PROTOCOL_READY, "product_sources_and_graph": frozen_product, "runner_inputs": frozen_runner,
              "cases_sha256": digest(evidence / "cases.json"), "ordinary_memory_limit_bytes": MEMORY_LIMIT,
              "cli_requested": options.etas, "commands": [dict(item, status="not_run") for item in cases]}
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: construction only; no server, CLI, File or Etas dispatch", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    fixture_before = snapshot(options.fixture_root)
    assert fixture_before == snapshot(once.FIXTURE / "workspace")
    mount = next(line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[4] == str(options.fixture_root))
    assert "ro" in mount[5].split(","), "synthetic fixture must be read-only"
    initial = resources()
    assert cli.is_file() and os.access(cli, os.X_OK) and initial["memory.max"] == str(MEMORY_LIMIT)
    result.update(status="running", cli_path=str(cli), cli_sha256=digest(cli), fixture_before=fixture_before, fixture_mount=mount, initial_resources=initial)
    save(output, result)
    failure = None
    try:
        for ordinal, command in enumerate(result["commands"]):
            directory = evidence / "commands" / (str(ordinal).zfill(3) + "-" + command["label"])
            project = directory / "project"
            for source in paths:
                if source.name != "etas.toml":
                    retain(source, project / source.relative_to(ROOT))
            (project / "etas.toml").write_text(manifest(command, options.fixture_root))
            copied = {str(path.relative_to(project)): digest(path) for path in (project / "src").rglob("*.es")}
            assert copied == {name: value for name, value in frozen_product.items() if name.startswith("src/")}
            project_inputs = {str(path.relative_to(project)): digest(path) for path in project.rglob("*") if path.is_file()}
            trace_path = directory / "trace.json"
            profile = {"missing-model": "foundation", "missing-file": "gateway-qwen"}.get(command["profile_mode"], "gateway-qwen-readonly")
            argv = [str(cli), "run", str(project), "--flow", specification.FLOW, "--profile", profile, "--allow-effects", "--trace-out", str(trace_path)]
            if command["args"]:
                argv += ["--args", *command["args"]]
            save(directory / "argv.json", argv)
            save(directory / "case.json", cases[ordinal])
            save(directory / "inputs.json", project_inputs)
            (directory / "stdin.bin").write_bytes(command["stdin"].encode("utf-8"))
            before = resources()
            assert before["memory.max"] == str(MEMORY_LIMIT) and hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
            command.update(status="running", command=argv, inputs=project_inputs, resources_before=before, started_utc=datetime.now(timezone.utc).isoformat())
            save(output, result)
            started = time.monotonic()
            stdout, stderr, code, timed_out, proof, pty_failure, records = run_chat(argv, command, options.timeout)
            after = resources()
            for name, raw in [("stdout", stdout), ("stderr", stderr)]:
                path = directory / (name + ".bin")
                path.write_bytes(raw)
                command.update({name + "_base64": base64.b64encode(raw).decode("ascii"), name + "_sha256": digest(path), name + "_retained": str(path.relative_to(evidence))})
            save(directory / "http-observations.json", records)
            if proof is not None:
                save(directory / "terminal-observation.json", proof)
                command.update(terminal_observation=proof, terminal_retained=str((directory / "terminal-observation.json").relative_to(evidence)))
            command.update(exit=code, timeout=timed_out, actual_http_count=len(records), resources_after=after,
                           elapsed_seconds=time.monotonic() - started, http_observations_sha256=digest(directory / "http-observations.json"),
                           http_observations_retained=str((directory / "http-observations.json").relative_to(evidence)),
                           expected_stdout=specification.expected_stdout(command), status="observed")
            if trace_path.is_file():
                command.update(trace_sha256=digest(trace_path), trace_retained=str(trace_path.relative_to(evidence)))
            save(output, result)
            observed = validate(command, stdout, stderr, code, json.loads(trace_path.read_text()), records, timed_out, proof, pty_failure)
            command.update(observed)
            assert hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
            assert snapshot(options.fixture_root) == fixture_before
            assert all((project / name).is_file() and digest(project / name) == value for name, value in project_inputs.items())
            assert after["memory.max"] == str(MEMORY_LIMIT) and pressure(before) == pressure(after)
            command["status"] = "passed"
            save(output, result)
            print("PASS " + command["label"] + " HTTP=" + str(len(records)), flush=True)
        specification.assert_dependence(result["commands"])
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "command" in locals():
            command.update(status="failed", failure=failure)
    finally:
        unchanged = hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        result.update(status="passed" if failure is None and all(item["status"] == "passed" for item in result["commands"]) and unchanged else "failed",
                      protected_inputs_unchanged=unchanged, fixture_after=snapshot(options.fixture_root), cli_unchanged=digest(cli) == result["cli_sha256"],
                      finished_utc=datetime.now(timezone.utc).isoformat())
        if result["fixture_after"] != fixture_before or not result["cli_unchanged"]:
            result["status"] = "failed"
        if failure:
            result["failure"] = failure
        save(output, result)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
