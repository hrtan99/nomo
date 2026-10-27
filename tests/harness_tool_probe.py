#!/usr/bin/env python3
"""Actual complete-root main -> tool child -> main tests on loopback fixtures.

Python supplies bounded HTTP protocol replies and independent observations only.
All orchestration, admission, shared accounting and File work run in real Etas.
The serial owner dispatches this runner only after its actual full-root preflight.
"""
import argparse
import base64
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tomllib

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/harness_tool001"
PORT, REFUSED_PORT = 18861, 18862
MEMORY_LIMIT = 4294967296
sys.path.insert(0, str(ROOT / "tests"))


def load(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


previous = load("accepted_harness_model_helpers", ROOT / "tests/harness_model_probe.py")
tools = load("accepted_model_file_helpers", ROOT / "tests/model_tool_probe.py")
specification = load("tool_harness_exact_cases", FIXTURE / "cases.py")
digest, save, retain = previous.digest, previous.save, previous.retain
resources, pressure = previous.resources, previous.pressure
encoded, event, snapshot = tools.encoded, tools.event, tools.snapshot


def product_paths():
    sources = sorted((ROOT / "src").rglob("*.es"))
    required = ["harness/harness_tool_contract.es", "harness/harness_model_tools.es", "entry/harness_model_tools_entry.es"]
    if len(sources) != 71 or any(not (ROOT / "src/nomo" / name).is_file() for name in required):
        raise ValueError("the actual complete 71-module product is required")
    if any(path.name.startswith("model_session") for path in sources):
        raise ValueError("pending shared model_session source is not part of this product")
    return sources + [ROOT / "etas.toml", ROOT / "etas.lock"]


def hashes(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def manifest(item, fixture_root):
    text = (ROOT / "etas.toml").read_text()
    text = text.replace("http://model-gateway:8080/v1", "http://127.0.0.1:" + str(REFUSED_PORT if item["profile_mode"] == "connection" else PORT) + "/v1")
    text = text.replace("NOMO_GATEWAY_CLIENT_TOKEN", "NOMO_HARNESS_TOOL_TEST_KEY")
    text = text.replace("request_deadline_ms = 120000", "request_deadline_ms = 500").replace("connect_timeout_ms = 2000", "connect_timeout_ms = 200")
    text = text.replace('root = "/model-tool-fixture"', "root = " + encoded(str(fixture_root / item["variant"])))
    if item["profile_mode"] == "denied-model":
        text = text.replace('"model=allow"', '"model=deny"')
    if item["profile_mode"] == "denied-file":
        text = text.replace('"filesystem=allow"', '"filesystem=deny"')
    profiles = tomllib.loads(text)["runtime"]["profiles"]
    selected = profiles["gateway-qwen-readonly"]
    assert selected["filesystem"]["regions"] == {"nomo.tools.workspace.ReadOnlyRoot": {
        "root": str(fixture_root / item["variant"]), "read": True, "write": False}}, "test region changed authority"
    assert selected["approval"] == {"mode": "deny"}
    assert selected["model"]["retry"] == {"attempts": 1, "delay_ms": 0}
    assert "http://model-gateway" not in text and "120000" not in text, "test must never contact the live gateway"
    return text


def phase(context):
    if "phase" in context:
        return context["phase"]
    return "child-final" if context["final_only"] else "child-first"


def reply(item, context):
    current = phase(context)
    if current == "plan":
        return item.get("plan_raw", encoded(["delegate", item["task"]]))
    if current == "aggregate":
        return specification.parent_answer(item, context["result"], context["tool"], context["outcome"])
    if current == "child-first":
        action = item["action"]
        if action[0] == "final":
            action = ["final", item.get("child_text", action[1])]
        return item.get("action_raw", encoded(action))
    if "second_raw" in item:
        return item["second_raw"]
    completed = [entry["text"] for entry in context["history"] if entry["role"] == "tool" and entry["kind"] == "complete"]
    if len(completed) != 1:
        raise ValueError("child response requires one actual completed File outcome")
    return encoded(["final", item.get("child_text", "Seen: " + completed[0])])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(size) if 0 < size <= 32768 else b""
        record = {"path": self.path, "headers": dict(self.headers), "request_base64": base64.b64encode(raw).decode("ascii"),
                  "received_utc": datetime.now(timezone.utc).isoformat(), "received_monotonic": time.monotonic(), "finished": threading.Event()}
        with self.server.records_lock:
            self.server.records.append(record)
        try:
            request = json.loads(raw)
            context = json.loads(request["messages"][1]["content"])
            record.update(request=request, context=context, phase=phase(context))
            if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + specification.TOKEN:
                raise ValueError("unexpected loopback path or authentication")
            text = reply(self.server.item, context)
            mode = self.server.item.get("fail_mode", "ok") if self.server.item.get("fail_phase") == phase(context) else "ok"
            if mode == "empty":
                text = ""
            body = {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}
            status = 200
            if mode == "unavailable":
                status, body = 503, {"error": {"message": "bounded loopback tool-child fixture unavailable"}}
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


def run_model(argv, item, timeout):
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.item, server.records, server.records_lock = item, [], threading.Lock()
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    reserved = None
    if item["profile_mode"] == "connection":
        reserved = socket.socket()
        reserved.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        reserved.bind(("127.0.0.1", REFUSED_PORT))
    thread.start()
    environment = dict(os.environ, NOMO_HARNESS_TOOL_TEST_KEY=specification.TOKEN)
    process = subprocess.Popen(argv, cwd=ROOT, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = process.communicate(b"", timeout=timeout)
        returned = time.monotonic()
    except subprocess.TimeoutExpired:
        import signal
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        returned, timed_out = time.monotonic(), True
    finally:
        server.shutdown()
        thread.join(timeout=2)
        for record in server.records:
            record["finished"].wait(2)
        server.server_close()
        if reserved is not None:
            reserved.close()
    records = [{key: value for key, value in record.items() if key != "finished"} for record in server.records]
    if records:
        records[-1]["process_returned_after_request_seconds"] = returned - records[-1]["received_monotonic"]
    return stdout, stderr, process.returncode, timed_out, records


def assert_http(item, records):
    assert len(records) == item["calls"], "HTTP count differs; no retry or later aggregation is allowed"
    tool = outcome = result = ""
    expected_phases = ["plan", "child-first"]
    if item["action"][0] != "final":
        expected_phases += ["child-final"]
    expected_phases += ["aggregate"]
    systems = {}
    for ordinal, record in enumerate(records):
        assert "observer_error" not in record, "HTTP fixture observer rejected actual request"
        request, context = record["request"], record["context"]
        current = phase(context)
        assert current == expected_phases[ordinal], "main/child request order changed"
        assert request["model"] == "Qwen3.5-9B-MLX-4bit" and request["max_tokens"] == 2048
        assert request["chat_template_kwargs"] == {"enable_thinking": False}
        assert [message["role"] for message in request["messages"]] == ["system", "user"], "untrusted context changed roles"
        assert len(request["messages"][1]["content"]) <= 2048, "complete actual model context exceeds bound"
        if current in {"plan", "aggregate"}:
            expected = {"phase": current, "request": item["request"], "task": "" if current == "plan" else item["task"],
                        "result": "" if current == "plan" else result, "tool": "" if current == "plan" else tool,
                        "outcome": "" if current == "plan" else outcome, "allowed": item["allowed"]}
            assert context == expected, "parent did not receive the selected request/task/actual child outcome"
            assert "main agent coordinating" in request["messages"][0]["content"]
            role = "main"
        else:
            history = [event("user", "context", item["request"], "original"), event("user", "input", item["task"])]
            if current == "child-final":
                tool, outcome = specification.expected_outcome(item)
                raw_action = item.get("action_raw", encoded(item["action"]))
                history += [event("model", "text", "", "qwen"), event("model", "request", raw_action, tool), event("tool", "complete", outcome, tool)]
            assert context == {"history": history, "allowed": item["allowed"], "final_only": current == "child-final"}, "child lost original/task/actual File outcome"
            assert "at most one read-only tool" in request["messages"][0]["content"]
            role = "child"
        system = request["messages"][0]["content"]
        assert role not in systems or systems[role] == system, "agent system changed between phases"
        systems[role] = system
        if current == "child-first" and item["action"][0] == "final":
            result = specification.child_answer(item, "")
        if current == "child-final":
            result = specification.child_answer(item, outcome)
    if "main" in systems and "child" in systems:
        assert systems["main"] != systems["child"], "actual child must use the separate accepted ETAS agent"
    if item.get("fail_mode") == "timeout":
        assert 0.35 <= records[-1]["process_returned_after_request_seconds"] < 2, "short request deadline was not observed"
    return [record["context"] for record in records]


def assert_trace(item, trace, records):
    assert trace.get("schema") == "etas.cli.interpreter-report.v1", "actual Host report missing"
    assert trace.get("incomplete") is not True and trace["termination"]["local_work_settled"] is True
    started = [entry for entry in trace.get("events", []) if entry["kind"] == "host_request_started"]
    finished = {entry["id"]: entry for entry in trace.get("events", []) if entry["kind"] == "host_request_finished"}
    agents = ["nomo.harness.harness_model_tools.MainModel", "nomo.agent.model_tool.ToolModel"]
    qualified = ["Agentic.infer[" + agents[0] + ", string]", "Agentic.infer[" + agents[1] + ", string]"]
    model_names = {"Model.infer", "Agentic.infer", *qualified}
    controls = {"Policy.evaluate", "Approval.request"}
    assert all(entry.get("qualified_action", "").startswith("Console.") or entry.get("qualified_action") in model_names | controls | {"Fs.read"}
               for entry in started), "unexpected Host authority"
    models = [entry for entry in started if entry.get("qualified_action") in model_names]
    files = [entry for entry in started if entry.get("request_kind") == "filesystem" or entry.get("qualified_action", "").startswith("Fs.")]
    assert len(files) == item["reads"] and all(entry["qualified_action"] == "Fs.read" and entry["request_kind"] == "filesystem" for entry in files)
    assert all(entry["id"] in finished for entry in files), "actual File outcome missing"
    failed_file = bool(item.get("file_failed"))
    assert all(finished[entry["id"]]["outcome"]["kind"] == ("failed" if failed_file and index == len(files) - 1 else "succeeded")
               for index, entry in enumerate(files)), "actual File completion differs"
    expected = [qualified[0], qualified[1]] + ([] if item["action"][0] == "final" else [qualified[1]]) + [qualified[0]]
    limit = 1 if item["profile_mode"] in {"denied-model", "connection"} else item["calls"]
    expected = expected[:limit]
    assert all(entry["qualified_action"] in {wanted, "Model.infer", "Agentic.infer"} for entry, wanted in zip(models, expected)), "agent inference order differs"
    assert len(records) <= len(models) <= len(expected), "HTTP requests exceed traced calls or an extra inference occurred"
    if item["kind"] != "host_abort":
        assert len(models) == item["calls"], "settled route inference count differs"
    sequence = ["file" if entry in files else "model" for entry in started if entry in files or entry in models]
    wanted = ["model", "model"] + ["file"] * item["reads"] + ([] if item["action"][0] == "final" else ["model"]) + ["model"]
    assert sequence == wanted[:len(sequence)], "File work moved outside the delegated child or past a refusal"
    return {"model_actions": models, "file_actions": files, "file_finished": [finished[entry["id"]] for entry in files]}


def validate(item, stdout, stderr, code, trace, records):
    assert code == (0 if item["kind"] in {"success", "help"} else 3), "true OS exit differs"
    assert stdout == specification.expected_stdout(item).encode("utf-8"), "exact tool-child transcript differs"
    assert specification.TOKEN.encode() not in stdout + stderr, "fixture token reached terminal"
    contexts = assert_http(item, records)
    observed = assert_trace(item, trace, records)
    if item["kind"] == "host_abort":
        assert stderr and specification.WRAPPER.encode() not in stderr and b"LEDGER " not in stdout, "Host abort must not claim a caught settlement"
        if item["profile_mode"].startswith("missing-"):
            assert b"analysis::MissingHostHandler" in stderr and trace["events"] == []
            assert trace["outcome"]["failure"]["kind"] == "preparation_rejected"
            assert any(entry["code"] == "Analysis(MissingHostHandler)" for entry in trace["diagnostics"])
        elif item["profile_mode"].startswith("denied-"):
            assert b"denied" in stderr.lower(), "policy refusal diagnostic missing"
        elif item.get("file_failed"):
            assert b"No such file" in stderr, "real missing-file diagnostic missing"
        elif item.get("fail_mode") == "empty":
            assert b"analysis::UnhandledRuntimeError" in stderr and b"OpenAI-compatible response contained no assistant content or tool calls" in stderr
        if item.get("fail_phase") in {"child-first", "child-final"} or item.get("file_failed") or item["profile_mode"] == "denied-file":
            assert b"RESERVATION child-1 " in stdout and b"unresolved=true" in stdout and b"SETTLED " not in stdout
    elif item["kind"] not in {"success", "help"}:
        assert b"analysis::ExecutionAborted" in stderr and specification.WRAPPER.encode() in stderr
    else:
        assert not stderr, "successful route wrote stderr"
    return {"contexts": contexts, "final_lines": [line for line in stdout.decode("utf-8").splitlines() if line.startswith("FINAL ")], **observed}


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
        parser.error("actual execution requires the selected absolute Etas executable")
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == path or path in destination.parents for path in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("evidence must be persistent")
    paths, cases = product_paths(), specification.cases()
    runner_paths = [Path(__file__).resolve(), FIXTURE / "cases.py", ROOT / "tests/model_tool_probe.py", ROOT / "tests/harness_model_probe.py",
                    ROOT / "tests/harness_chat_probe.py", ROOT / "tests/harness_entry_probe.py", ROOT / "tests/foundation_probe.py",
                    ROOT / "tests/normal_graph_identity.py", ROOT / "tests/fixtures/harness_model001/cases.py",
                    previous.graph_identity.bootstrap_path(), ROOT / "config/etas-latest-main.json"]
    runner_paths += sorted(path for path in (FIXTURE / "workspace").rglob("*") if path.is_file())
    frozen_product, frozen_runner = hashes(paths), hashes(runner_paths)
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness-tool001-", dir=destination))
    for source in paths + runner_paths:
        retain(source, evidence / "frozen-inputs" / source.relative_to(ROOT))
    save(evidence / "cases.json", cases)
    result = {"task": "HARNESS-TOOL-001A", "status": "not_run", "prepared_only": options.prepare_only,
              "created_utc": datetime.now(timezone.utc).isoformat(), "case_count": len(cases), "product_root": str(ROOT),
              "scope": "actual complete-root tool-child entry; separate pure contract runner is not substituted",
              "product_sources_and_graph": frozen_product, "runner_inputs": frozen_runner, "cases_sha256": digest(evidence / "cases.json"),
              "fixture_root": str(options.fixture_root), "ordinary_memory_limit_bytes": MEMORY_LIMIT,
              "cli_requested": options.etas, "commands": [dict(item, status="not_run") for item in cases]}
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: fixture construction only; no server, CLI, File or Etas dispatch", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    before_fixture = snapshot(options.fixture_root)
    assert before_fixture == snapshot(FIXTURE / "workspace"), "mounted immutable fixture differs from retained repository input"
    mount = next(line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[4] == str(options.fixture_root))
    assert "ro" in mount[5].split(","), "actual synthetic workspace must be read-only"
    initial = resources()
    assert cli.is_file() and os.access(cli, os.X_OK) and initial["memory.max"] == str(MEMORY_LIMIT)
    result.update(status="running", cli_path=str(cli), cli_sha256=digest(cli), initial_resources=initial,
                  fixture_before=before_fixture, fixture_mount=mount)
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
            assert copied == {name: value for name, value in frozen_product.items() if name.startswith("src/")}, "complete product copy differs"
            project_inputs = {str(path.relative_to(project)): digest(path) for path in project.rglob("*") if path.is_file()}
            trace_path = directory / "trace.json"
            profile = {"missing-model": "foundation", "missing-file": "gateway-qwen"}.get(command["profile_mode"], "gateway-qwen-readonly")
            argv = [str(cli), "run", str(project), "--flow", "harness_model_tools", "--profile", profile, "--allow-effects", "--trace-out", str(trace_path)]
            if command["args"]:
                argv += ["--args", *command["args"]]
            save(directory / "argv.json", argv)
            save(directory / "case.json", cases[ordinal])
            save(directory / "inputs.json", project_inputs)
            (directory / "stdin.bin").write_bytes(b"")
            before = resources()
            assert before["memory.max"] == str(MEMORY_LIMIT) and hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
            command.update(status="running", command=argv, inputs=project_inputs, resources_before=before,
                           started_utc=datetime.now(timezone.utc).isoformat())
            selected_files = command["action"][1:2] if command["action"][0] == "read" else command["action"][2:] if command["action"][0] == "search" else []
            command["fixture_read_inputs"] = [{"name": name, "bytes": path.stat().st_size, "sha256": digest(path)}
                                               for name in selected_files[:command["reads"]]
                                               if (path := options.fixture_root / command["variant"] / name).is_file()]
            save(output, result)
            started = time.monotonic()
            stdout, stderr, code, timed_out, records = run_model(argv, command, options.timeout)
            after = resources()
            for name, raw in [("stdout", stdout), ("stderr", stderr)]:
                path = directory / (name + ".bin")
                path.write_bytes(raw)
                command.update({name + "_base64": base64.b64encode(raw).decode("ascii"), name + "_sha256": digest(path), name + "_retained": str(path.relative_to(evidence))})
            save(directory / "http-observations.json", records)
            command.update(exit=code, timeout=timed_out, actual_http_count=len(records), resources_after=after,
                           elapsed_seconds=time.monotonic() - started, http_observations_sha256=digest(directory / "http-observations.json"),
                           http_observations_retained=str((directory / "http-observations.json").relative_to(evidence)),
                           expected_stdout=specification.expected_stdout(command), status="observed")
            if trace_path.is_file():
                command.update(trace_sha256=digest(trace_path), trace_retained=str(trace_path.relative_to(evidence)))
            save(output, result)
            assert not timed_out, "actual process watchdog expired"
            observed = validate(command, stdout, stderr, code, json.loads(trace_path.read_text()), records)
            command.update(observed)
            assert hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner, "protected source/fixture changed"
            assert snapshot(options.fixture_root) == before_fixture, "read-only fixture changed"
            assert all((project / name).is_file() and digest(project / name) == value for name, value in project_inputs.items())
            assert after["memory.max"] == str(MEMORY_LIMIT) and pressure(before) == pressure(after), "resource ceiling/OOM events changed"
            command["status"] = "passed"
            save(output, result)
            print("PASS " + command["label"] + " HTTP=" + str(len(records)) + " File=" + str(command["reads"]), flush=True)
        alpha, beta = result["commands"][:2]
        assert alpha["request"] == beta["request"] and alpha["task"] == beta["task"] and alpha["allowed"] == beta["allowed"]
        for key in ["outcome", "result"]:
            assert alpha["contexts"][-1][key] != beta["contexts"][-1][key], "changed File bytes did not change the actual parent evidence"
        assert len(alpha["final_lines"]) == len(beta["final_lines"]) == 1 and alpha["final_lines"] != beta["final_lines"], "changed File bytes did not change the final answer"
        result["byte_dependence_proved"] = True
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "command" in locals():
            command.update(status="failed", failure=failure)
    finally:
        unchanged = hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        fixture_after = snapshot(options.fixture_root)
        cli_unchanged = digest(cli) == result["cli_sha256"]
        result.update(status="passed" if failure is None and all(item["status"] == "passed" for item in result["commands"]) and unchanged else "failed",
                      protected_inputs_unchanged=unchanged, fixture_after=fixture_after, cli_unchanged=cli_unchanged,
                      finished_utc=datetime.now(timezone.utc).isoformat())
        if fixture_after != before_fixture or not cli_unchanged:
            result["status"] = "failed"
        if failure:
            result["failure"] = failure
        save(output, result)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
