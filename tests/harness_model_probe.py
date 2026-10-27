#!/usr/bin/env python3
"""Real Model Host main/child/main tests with bounded loopback protocol replies.

Python supplies HTTP fixtures, never Nomo orchestration or a model policy. The
normal product is copied byte-for-byte; only each test manifest changes
the existing provider endpoint/profile. Old offline entry fixtures are reused
unchanged on the new complete root. Pure defensive tests are labeled separately.
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

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/harness_model001"
PORT = 18859
REFUSED_PORT = 18860
MEMORY_LIMIT = 4294967296


def load_module(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


previous = load_module("accepted_chat_evidence_helpers", ROOT / "tests/harness_chat_probe.py")
specification = load_module("model_harness_exact_cases", FIXTURE / "cases.py")
graph_identity = load_module("selected_normal_graph_identity", ROOT / "tests/normal_graph_identity.py")
digest, save, retain = previous.digest, previous.save, previous.retain
resources, pressure = previous.resources, previous.pressure


def product_paths():
    sources = sorted((ROOT / "src").rglob("*.es"))
    if len(sources) != 84 or any(path.name.startswith("model_session") for path in sources):
        raise ValueError("expected isolated actual 84-file product, not pending shared root")
    return sources + [ROOT / "etas.toml", ROOT / "etas.lock"]


def hashes(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def manifest(mode="normal"):
    text = (ROOT / "etas.toml").read_text()
    text = text.replace("gateway-qwen", "harness-model-mock")
    text = text.replace("http://model-gateway:8080/v1", "http://127.0.0.1:" + str(REFUSED_PORT if mode == "connection" else PORT) + "/v1")
    text = text.replace("NOMO_GATEWAY_CLIENT_TOKEN", "NOMO_HARNESS_MODEL_TEST_KEY")
    text = text.replace("request_deadline_ms = 120000", "request_deadline_ms = 500")
    text = text.replace("connect_timeout_ms = 2000", "connect_timeout_ms = 200")
    if mode == "denied":
        text = text.replace('"model=allow"', '"model=deny"')
    if "http://model-gateway" in text or "request_deadline_ms = 120000" in text:
        raise ValueError("test manifest must never retain the real gateway")
    return text


PURE_MANIFEST = '''[package]
name = "nomo-model-harness-pure-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "foundation"
[runtime.profiles.foundation]
boundary_policy = "nomo-model-harness-pure-probe"
[runtime.profiles.foundation.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.foundation.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "nomo.harness_model_probe"
flow = "observe"
profile = "foundation"
'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(size) if 0 < size <= 32768 else b""
        record = {"path": self.path, "headers": dict(self.headers), "request_base64": base64.b64encode(raw).decode("ascii"),
                  "received_utc": datetime.now(timezone.utc).isoformat(), "received_monotonic": time.monotonic(),
                  "finished": threading.Event()}
        with self.server.records_lock:
            index = len(self.server.records)
            self.server.records.append(record)
        item = self.server.item
        try:
            request = json.loads(raw)
            record["request"] = request
            context = json.loads(request["messages"][1]["content"])
            record["context"] = context
            if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + specification.TOKEN:
                raise ValueError("unexpected fixture path/authentication")
            if item["kind"] == "provider_smoke":
                text = "text:" + context["request"]
            elif index == 0:
                text = item.get("plan_raw", specification.encoded(["delegate", item["task"]]))
                if "plan_raw" not in item and item["task"] == "work:" + item["request"]:
                    text = specification.encoded(["delegate", "work:" + context["request"]])
            elif index == 1:
                text = item.get("child_text", item["child_tag"] + ":" + context["task"] + "|" + context["request"])
            elif index == 2:
                text = item.get("final_text", "answer:" + context["result"])
            else:
                raise ValueError("unexpected fourth model request/retry")
            mode = item.get("fail_mode", "ok") if item.get("fail_stage") == index + 1 else "ok"
            body = {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}
            status = 200
            if mode == "unavailable":
                status, body = 503, {"error": {"message": "bounded loopback fixture unavailable"}}
            elif mode == "missing_usage":
                del body["usage"]
            elif mode == "wrong_shape":
                body["choices"] = []
            elif mode == "token_overrun":
                body["usage"] = {"prompt_tokens": 2048, "completion_tokens": 1, "total_tokens": 2049}
            reply = b"not-json" if mode == "malformed" else specification.encoded(body).encode("ascii")
            record.update(response_status=status, response_base64=base64.b64encode(reply).decode("ascii"),
                          response_text=text, fixture_mode=mode)
            if mode == "timeout":
                record["deliberate_delay_seconds"] = 0.85
                threading.Event().wait(0.85)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            try:
                self.wfile.write(reply)
                record["response_write"] = "completed"
            except (BrokenPipeError, ConnectionResetError):
                record["response_write"] = "client already aborted"
        except Exception as error:
            record["observer_error"] = type(error).__name__ + ": " + str(error)
            try:
                self.send_error(500, "fixture request observation failed")
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
        reserved.bind(("127.0.0.1", REFUSED_PORT))  # Bound, deliberately not listening.
    thread.start()
    environment = dict(os.environ, NOMO_HARNESS_MODEL_TEST_KEY=specification.TOKEN)
    process = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment, start_new_session=True)
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
    assert len(records) == item["calls"], "actual HTTP count differs; no retry or later stage is allowed"
    contexts = []
    for ordinal, record in enumerate(records):
        assert "observer_error" not in record, "HTTP fixture observer rejected real request"
        request, current = record["request"], record["context"]
        assert request["model"] == "Qwen3.5-9B-MLX-4bit" and request["max_tokens"] == 2048, "normal model/token allowance changed"
        assert request["chat_template_kwargs"] == {"enable_thinking": False}, "thinking configuration changed"
        assert [message["role"] for message in request["messages"]] == ["system", "user"], "untrusted context escaped data role"
        assert len(request["messages"][1]["content"]) <= 2048, "complete Prompt.data exceeded contract"
        if item["kind"] == "provider_smoke":
            assert current == {"history": [], "request": item["request"]}, "existing TextModel context changed"
        else:
            expected = specification.context(["plan", "child", "aggregate"][ordinal], item["request"],
                                             "" if ordinal == 0 else item["task"],
                                             specification.expected_child(item) if ordinal == 2 else "")
            assert current == expected, "actual selected request/task/child context differs"
            system = request["messages"][0]["content"]
            assert ("You are child-1" if ordinal == 1 else "You are the main agent") in system, "main/child role selection changed"
        contexts.append(current)
    if len(records) == 3:
        assert records[0]["request"]["messages"][0] == records[2]["request"]["messages"][0], "main plan/aggregate must use same accepted agent"
        assert records[0]["request"]["messages"][0] != records[1]["request"]["messages"][0], "child must use distinct ETAS agent"
    if item.get("fail_mode") == "timeout":
        assert 0.35 <= records[-1]["process_returned_after_request_seconds"] < 2, "short request deadline was not observed"
    return contexts


def assert_trace(trace, expected_actions, *, abort=False, pure=False):
    assert trace.get("schema") == "etas.cli.interpreter-report.v1", "missing actual Host trace schema"
    assert trace.get("incomplete") is not True and trace["termination"]["local_work_settled"] is True, "trace did not settle local work"
    started = [event for event in trace.get("events", []) if event["kind"] == "host_request_started"]
    actions = [event.get("qualified_action", "") for event in started]
    # Host traces may name the lowered Model service rather than the frontend
    # Agentic effect. Keep the exact observed labels: agent identity/order is
    # also checked independently through real HTTP systems/data and effects.
    model_names = {"Model.infer", "Agentic.infer", *expected_actions}
    controls = {"Policy.evaluate", "Approval.request"}
    assert all(action.startswith("Console.") or action in model_names or action in controls for action in actions), "unexpected File/Command/Session/Memory authority"
    model = [action for action in actions if action in model_names]
    aligned = all(actual == expected or actual in {"Model.infer", "Agentic.infer"}
                  for actual, expected in zip(model, expected_actions))
    if abort:
        assert aligned and len(model) <= len(expected_actions), "Host abort inference action count/order differs"
    else:
        assert aligned and len(model) == len(expected_actions), "actual inference action count/order differs"
    if pure:
        assert not model, "pure defensive fixture dispatched Model Host"
    return model


def construct(suite):
    values = []
    if suite in {"all", "model"}:
        for item in specification.cases():
            values.append(dict(item, scope="actual-model-product-entry", transport="model", expected_stdout=specification.expected_stdout(item),
                               expected_exit=0 if item["kind"] in {"success", "help", "provider_smoke"} else 3))
    if suite in {"all", "offline"}:
        values.extend(dict(item, scope="unchanged-offline-entry-composition") for item in previous.load_cases())
    if suite in {"all", "pure"}:
        pure = specification.pure_cases()
        expected = "".join("CASE " + str(index) + " " + item["label"] + "\nPASS " + str(index) + " " + item["label"] + "\n"
                           for index, item in enumerate(pure)) + "PASS HARNESS_MODEL_PURE " + str(len(pure)) + "\n"
        values.append({"label": "pure-defensive-model-contract", "scope": "pure-defensive-contract-component-not-product-entry",
                       "transport": "pure", "mode": "observe", "args": [], "stdin": specification.encoded(pure),
                       "expected_stdout": expected, "expected_exit": 0, "fixture_count": len(pure)})
    labels = [item["label"] for item in values]
    if len(values) != len(set(labels)) or not 0 < len(values) <= 256:
        raise ValueError("all case labels/count must be bounded and unique")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--etas")
    parser.add_argument("--suite", choices=["all", "model", "offline", "pure"], default="all")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=240)
    options = parser.parse_args()
    if not 1 <= options.timeout <= 600:
        parser.error("timeout must be in 1..600 seconds")
    if not options.prepare_only and (not options.etas or not Path(options.etas).is_absolute()):
        parser.error("an absolute normal CLI is required for actual execution")
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == path or path in destination.parents for path in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("evidence must be persistent, not temporary")
    paths, cases = product_paths(), construct(options.suite)
    runner_paths = [Path(__file__).resolve(), FIXTURE / "cases.py", FIXTURE / "contract_probe.es",
                    ROOT / "tests/harness_chat_probe.py", ROOT / "tests/fixtures/harness002a/cases.py",
                    ROOT / "tests/harness_entry_probe.py", ROOT / "tests/fixtures/harness001b/cases.py",
                    ROOT / "tests/foundation_probe.py", ROOT / "tests/normal_graph_identity.py",
                    graph_identity.bootstrap_path()]
    frozen_product, frozen_runner = hashes(paths), hashes(runner_paths)
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness-model001-", dir=destination))
    for source in paths + runner_paths:
        retain(source, evidence / "frozen-inputs" / source.relative_to(ROOT))
    save(evidence / "cases.json", cases)
    save(evidence / "server-plans.json", specification.cases())
    result = {"task": "HARNESS-MODEL-001A", "suite": options.suite, "status": "not_run", "prepared_only": options.prepare_only,
              "created_utc": datetime.now(timezone.utc).isoformat(), "product_root": str(ROOT), "case_count": len(cases),
              "scopes": {scope: sum(item["scope"] == scope for item in cases) for scope in sorted({item["scope"] for item in cases})},
              "product_sources_and_graph": frozen_product, "runner_inputs": frozen_runner, "cases_sha256": digest(evidence / "cases.json"),
              "server_plans_sha256": digest(evidence / "server-plans.json"), "ordinary_memory_limit_bytes": MEMORY_LIMIT,
              "cli_requested": options.etas, "cli_path": None, "cli_sha256": None, "commands": [dict(item, status="not_run") for item in cases]}
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: retained model/offline/pure case construction only; no HTTP server/CLI/Etas dispatch", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    result["initial_resources"] = resources()
    if not cli.is_file() or not os.access(cli, os.X_OK) or result["initial_resources"]["memory.max"] != str(MEMORY_LIMIT):
        result.update(status="pending_execution_environment", limitation="normal absolute CLI and exactly measured ordinary 4-GiB cgroup required; no actual command dispatched")
        save(output, result)
        return 2
    result.update(cli_path=str(cli), cli_sha256=digest(cli), status="running")
    save(output, result)
    failure = None
    try:
        for ordinal, command in enumerate(result["commands"]):
            directory = evidence / "commands" / (str(ordinal).zfill(3) + "-" + command["label"])
            directory.mkdir(parents=True)
            command["inputs"] = {}
            for source in paths + runner_paths:
                target = directory / "inputs" / source.relative_to(ROOT)
                command["inputs"][str(source.relative_to(ROOT))] = dict(retain(source, target), retained=str(target.relative_to(evidence)))
            project = ROOT
            if command["transport"] == "model":
                project = directory / "project"
                for source in paths:
                    if source.name != "etas.toml":
                        retain(source, project / source.relative_to(ROOT))
                (project / "etas.toml").write_text(manifest(command["profile_mode"]))
                command["product_copy_scope"] = "all 41 byte-identical product modules; generated test-only provider manifest"
                assert {str(path.relative_to(project)): digest(path) for path in (project / "src").rglob("*.es")} == {
                    name: value for name, value in frozen_product.items() if name.startswith("src/")}, "actual model product copy differs"
            elif command["transport"] == "pure":
                project = directory / "component-project"
                for name in ["harness/harness_model_contract.es", "core/text.es"]:
                    retain(ROOT / "src/nomo" / name, project / "src/nomo" / name)
                retain(FIXTURE / "contract_probe.es", project / "src/nomo/harness_model_probe.es")
                (project / "etas.toml").write_text(PURE_MANIFEST)
                command["product_copy_scope"] = "pure contract/text transitive component only, plus explicitly test-only Console observer"
            project_inputs = {}
            if project != ROOT:
                project_inputs = {str(path.relative_to(project)): digest(path) for path in sorted(project.rglob("*")) if path.is_file()}
            command["prepared_project_inputs"] = project_inputs
            command["executed_project"] = str(project)
            argv = [str(cli), "run", str(project)]
            if command["transport"] == "model":
                flow = "model" if command["kind"] == "provider_smoke" else "harness_model"
                profile = "foundation" if command["profile_mode"] == "missing" else "harness-model-mock"
                argv += ["--flow", flow, "--profile", profile]
            else:
                if command["mode"] != "default":
                    argv += ["--flow", command["mode"]]
                argv += ["--profile", "foundation"]
            trace_path = directory / "trace.json"
            argv += ["--allow-effects", "--trace-out", str(trace_path)]
            if command["args"]:
                argv += ["--args", *command["args"]]
            stdin = command.get("stdin", "").encode("utf-8")
            (directory / "stdin.bin").write_bytes(stdin)
            save(directory / "case.json", cases[ordinal])
            save(directory / "argv.json", argv)
            before = resources()
            assert before["memory.max"] == str(MEMORY_LIMIT), "ordinary memory ceiling changed"
            assert hashes(product_paths()) == frozen_product and hashes(runner_paths) == frozen_runner, "protected root/runner changed"
            assert digest(cli) == result["cli_sha256"], "normal CLI binary changed"
            command.update(command=argv, resources_before=before, status="running", started_utc=datetime.now(timezone.utc).isoformat())
            for name in ["stdin.bin", "case.json", "argv.json"]:
                key = name.split(".")[0]
                command[key + "_sha256"], command[key + "_retained"] = digest(directory / name), str((directory / name).relative_to(evidence))
            save(output, result)
            started = time.monotonic()
            records, terminal, pty_failure = [], None, None
            if command["transport"] == "model":
                stdout, stderr, code, timed_out, records = run_model(argv, command, options.timeout)
            elif command["transport"] == "pty":
                stdout, stderr, code, timed_out, terminal, pty_failure = previous.run_pty(argv, command, options.timeout)
            else:
                stdout, stderr, code, timed_out, _, _ = previous.run_pipe(argv, stdin, options.timeout)
            after = resources()
            (directory / "stdout.bin").write_bytes(stdout)
            (directory / "stderr.bin").write_bytes(stderr)
            save(directory / "http-observations.json", records)
            command.update(exit=code, timeout=timed_out, elapsed_seconds=time.monotonic() - started,
                           resources_after=after, finished_utc=datetime.now(timezone.utc).isoformat(), status="observed",
                           stdout_base64=base64.b64encode(stdout).decode("ascii"), stderr_base64=base64.b64encode(stderr).decode("ascii"),
                           actual_http_count=len(records), http_observations_retained=str((directory / "http-observations.json").relative_to(evidence)),
                           http_observations_sha256=digest(directory / "http-observations.json"))
            for name in ["stdout", "stderr"]:
                command[name + "_sha256"] = digest(directory / (name + ".bin"))
                command[name + "_retained"] = str((directory / (name + ".bin")).relative_to(evidence))
            if trace_path.is_file():
                command.update(trace_sha256=digest(trace_path), trace_retained=str(trace_path.relative_to(evidence)))
            if terminal is not None:
                save(directory / "terminal-observation.json", terminal)
                command.update(terminal_observation=terminal, terminal_sha256=digest(directory / "terminal-observation.json"),
                               terminal_retained=str((directory / "terminal-observation.json").relative_to(evidence)))
            save(output, result)
            assert not timed_out and not pty_failure, "actual process/terminal timed out or failed"
            assert code == command["expected_exit"] and stdout == command["expected_stdout"].encode(), "actual exit/transcript differs from exact fixture"
            trace = json.loads(trace_path.read_text())
            if command["transport"] == "model":
                command["observed_contexts"] = assert_http(command, records)
                if command["kind"] == "host_abort":
                    assert stderr and b"Nomo model harness refused" not in stderr and b"REFUSED " not in stdout and b"LEDGER " not in stdout, "Host abort must not claim a caught refusal/settlement"
                    if command["profile_mode"] == "missing":
                        assert b"analysis::MissingHostHandler" in stderr and b"missing Phase 1 host service for Agentic" in stderr and trace["events"] == [], "missing Model Host must stop before entry or dispatch"
                        assert trace["outcome"]["failure"]["kind"] == "preparation_rejected" and any(item["code"] == "Analysis(MissingHostHandler)" for item in trace["diagnostics"]), "missing Model Host must retain its preparation-rejected trace outcome"
                    if command.get("child_text") == "" or command.get("final_text") == "":
                        assert b"analysis::UnhandledRuntimeError" in stderr and b"OpenAI-compatible response contained no assistant content or tool calls" in stderr, "empty content must fail at the actual Model Host boundary"
                elif command["expected_exit"]:
                    assert b"analysis::ExecutionAborted" in stderr and specification.WRAPPER.encode() in stderr, "known refusal must fail at actual wrapper"
                else:
                    assert not stderr, "successful actual model route wrote stderr"
                actions = ["Agentic.infer[nomo.harness.harness_model.MainModel, string]", "Agentic.infer[nomo.harness.harness_model.ChildModel, string]", "Agentic.infer[nomo.harness.harness_model.MainModel, string]"]
                if command["kind"] == "provider_smoke":
                    actions = ["Agentic.infer[nomo.agent.provider.TextModel, string]"]
                command["observed_inference_actions"] = assert_trace(trace, actions[:command["last_stage"] or command["calls"]], abort=command["kind"] == "host_abort")
                assert len(command["observed_inference_actions"]) >= len(records), "observed HTTP requests exceed traced inference actions"
            elif command["transport"] == "pure":
                assert not stderr, "pure contract fixture wrote stderr"
                assert_trace(trace, [], pure=True)
            else:
                previous.validate(command, stdout, stderr, code, timed_out, pty_failure)
                if terminal is not None:
                    assert terminal["proc_child_descriptors_observed"], "actual PTY child descriptors were not observed"
                assert_trace(trace, [])
            assert after["memory.max"] == str(MEMORY_LIMIT) and pressure(before) == pressure(after), "ordinary memory ceiling/OOM events changed"
            assert hashes(product_paths()) == frozen_product and hashes(runner_paths) == frozen_runner, "protected source/runner changed"
            assert all((project / name).is_file() and digest(project / name) == value for name, value in project_inputs.items()), "executed project inputs changed"
            command["status"] = "passed"
            save(output, result)
            print("PASS " + command["label"], flush=True)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "command" in locals():
            command["status"] = "failed"
    finally:
        try:
            source_unchanged = hashes(product_paths()) == frozen_product and hashes(runner_paths) == frozen_runner
            cli_unchanged = cli.is_file() and digest(cli) == result["cli_sha256"]
        except (OSError, ValueError):
            source_unchanged = cli_unchanged = False
        complete = all(item["status"] == "passed" for item in result["commands"])
        result.update(status="passed" if complete and not failure and source_unchanged and cli_unchanged else "failed",
                      protected_inputs_unchanged=source_unchanged, cli_unchanged=cli_unchanged,
                      final_resources=resources(), finished_utc=datetime.now(timezone.utc).isoformat())
        if failure:
            result["failure"] = failure
        save(output, result)
    if result["status"] != "passed":
        print("FAILED " + result.get("failure", "protected identity changed"), flush=True)
        return 1
    print("PASS actual HARNESS-MODEL-001A selected scopes; component tests are not live-quality acceptance", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
