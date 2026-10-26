#!/usr/bin/env python3
"""Actual cross-process Harness continuation on fresh project-owned SQLite data.

Python supplies bounded loopback replies and independent observations. Etas
performs admission, restored accounting/context, new tool execution, publication
and data-only successor show. This runner never adopts a user's database.
"""
import argparse
import base64
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import harness_session_probe as previous

chat, storage = previous.chat, previous.storage
FIXTURE = ROOT / "tests/fixtures/harness_session001b/cases.py"
specification = chat.once.load("cross_process_successor_cases", FIXTURE)
digest, save, retain = previous.digest, previous.save, previous.retain
resources, pressure, snapshot = previous.resources, previous.pressure, previous.snapshot
MEMORY_LIMIT = previous.MEMORY_LIMIT
PROFILES = dict(previous.PROFILES, **{"continue": "harness-checkpoint-save", "successor-show": "harness-checkpoint-show"})
FLOWS = {"init": "harness_checkpoint_init", "save": "harness_checkpoint_save", "show": "harness_checkpoint_show",
         "continue": "harness_checkpoint_continue", "successor-show": "harness_successor_show"}
LEDGER_NAMES = ["steps", "calls", "tokens", "tools", "scan"]


def product_paths():
    sources = sorted((ROOT / "src").rglob("*.es"))
    if len(sources) != 54 or any(value.name.startswith("model_session") for value in sources):
        raise ValueError("actual complete isolated 54-module continuation product required")
    return sources + [ROOT / "etas.toml", ROOT / "etas.lock"]


def hashes(paths):
    return previous.hashes(paths)


def rows(directory):
    path = directory / "harness.sqlite3"
    if not path.exists():
        return {}
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
        values = connection.execute("SELECT region,path,key_json,value_json,version FROM memory_entries ORDER BY region,key_json").fetchall()
        receipts = connection.execute("SELECT region,path,key_json,version FROM memory_receipts WHERE kind='put'").fetchall()
        generations = {(region, store_path): generation for region, store_path, generation in connection.execute("SELECT region,path,generation FROM memory_stores")}
    result = {}
    for region, store_path, key, value, version in values:
        assert region in {specification.first.REGION, specification.REGION} and json.loads(store_path) == ["Rows"], "unexpected storage namespace"
        name = storage.untag(json.loads(key))
        identity = region + ":" + name
        assert identity not in result
        result[identity] = {"region": region, "path": store_path, "key_json": key, "value_json": value,
                            "value": storage.untag(json.loads(value)), "version": version}
        suffix = ":" + format(version, "016x")
        candidates = {token for receipt_region, receipt_path, receipt_key, token in receipts
                      if (receipt_region, receipt_path, receipt_key) == (region, store_path, key) and token.endswith(suffix)}
        assert len(candidates) == 1, "current entry has no unique independent committed Host receipt"
        token = candidates.pop()
        assert re.fullmatch(r"mv1:[0-9a-f]{64}:[0-9a-f]{32}:[0-9a-f]{16}", token)
        assert token.split(":")[2] == generations[(region, store_path)] and int(token.split(":")[3], 16) == version
        result[identity]["opaque_version"] = token
    return result


def old_rows(directory):
    prefix = specification.first.REGION + ":"
    return {key[len(prefix):]: value for key, value in rows(directory).items() if key.startswith(prefix)}


def new_rows(directory):
    prefix = specification.REGION + ":"
    return {key[len(prefix):]: value for key, value in rows(directory).items() if key.startswith(prefix)}


def ledger(values):
    assert len(values) == 5
    return dict(zip(LEDGER_NAMES, values))


def expected_record(item, predecessor, phase, *, body="", usage=None, resolved=False):
    return {"format": 1, "phase": phase,
            "predecessor": {"id": item["id"], "workspace": item["workspace"], "allowed": item["allowed"]},
            "successor": {"id": item["successor"], "workspace": item["workspace"], "allowed": item["allowed"]},
            "predecessor_version": predecessor["opaque_version"], "predecessor_body": predecessor["value"]["body"],
            "request": item["second"]["request"], "body": body,
            "usage": ledger(specification.prepared(item, "save")["ledger"] if usage is None else usage),
            "maximum": ledger(specification.MAXIMUM), "reserved": ledger([0] * 5 if resolved else [7, 4, 8192, 1, 4096]),
            "admitted": 2, "resolved": resolved}


class Handler(chat.Handler):
    def do_POST(self):
        # This independent SQLite read finishes before the first HTTP reply.
        # The actual trace additionally proves write+readback precede inference.
        if self.server.phase == "continue":
            observed = rows(self.server.directory)
            old = old_rows(self.server.directory)
            new = new_rows(self.server.directory)
            expected = expected_record(self.server.case, self.server.predecessor, "admitted")
            proof = {"before_response_utc": datetime.now(timezone.utc).isoformat(), "rows": observed,
                     "expected_admission": expected}
            self.server.admission_observations.append(proof)
            if old != self.server.old_snapshot or set(new) != {"admission:" + self.server.case["id"]} or new["admission:" + self.server.case["id"]]["value"] != expected:
                self.server.admission_error = "Model reached before durable exact predecessor-bound admission"
                self.send_error(500, "admission observation failed")
                return
        super().do_POST()


def run_process(argv, directory, model_case, timeout, *, phase, item, predecessor=None):
    server = thread = None
    environment = dict(os.environ)
    if model_case is not None:
        server = ThreadingHTTPServer(("127.0.0.1", chat.PORT), Handler)
        server.daemon_threads = True
        server.item, server.records, server.turn, server.lock = model_case, [], -1, threading.Lock()
        server.phase, server.case, server.directory = phase, item, directory
        server.predecessor = predecessor
        server.old_snapshot = old_rows(directory) if phase == "continue" and model_case["turns"] else {}
        server.admission_observations, server.admission_error = [], None
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        environment["NOMO_HARNESS_TOOL_TEST_KEY"] = specification.TOKEN
        thread.start()
    process = subprocess.Popen(argv, cwd=directory, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = process.communicate(b"", timeout=timeout)
        returned = time.monotonic()
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        returned, timed_out = time.monotonic(), True
    finally:
        if server is not None:
            server.shutdown()
            thread.join(timeout=2)
            for record in server.records:
                record["finished"].wait(2)
            server.server_close()
    records = [] if server is None else [{key: value for key, value in record.items() if key != "finished"} for record in server.records]
    if records:
        records[-1]["process_returned_after_request_seconds"] = returned - records[-1]["received_monotonic"]
    proof = {"observations": [] if server is None else server.admission_observations,
             "error": None if server is None else server.admission_error}
    return stdout, stderr, process.returncode, timed_out, records, process.pid, proof


def assert_http(item, phase, records):
    """Validate complete actual per-process contexts against explicit stored prior."""
    value = specification.prepared(item, phase)
    before = specification.chat.empty_prior() if phase == "save" else specification.prior(item)
    assert len(records) == value["calls"], "extra model retry, prior replay or inference"
    phases = ["plan", "child-first"] + ([] if value["action"][0] == "final" else ["child-final"]) + ["aggregate"]
    selected = specification.chat.selected(value)
    systems = {}
    for index, record in enumerate(records):
        assert "observer_error" not in record and record["turn"] == 1
        request, context, current = record["request"], record["context"], record["phase"]
        assert current == phases[index]
        assert request["model"] == "Qwen3.5-9B-MLX-4bit" and request["max_tokens"] == 2048
        assert request["chat_template_kwargs"] == {"enable_thinking": False}
        assert [message["role"] for message in request["messages"]] == ["system", "user"]
        assert len(request["messages"][1]["content"]) <= 2048
        if current in {"plan", "aggregate"}:
            expected = {"phase": current, "request": value["request"], "task": "", "result": "", "tool": "", "outcome": "",
                        "allowed": item["allowed"], "prior": before}
            if current == "aggregate":
                expected.update({key: selected[key] for key in ["task", "result", "tool", "outcome"]})
            assert context == expected, "restored parent prior/current data changed or lost"
            assert "main agent coordinating" in request["messages"][0]["content"]
            role = "main"
        else:
            history = [specification.chat.event("user", "context", value["request"], "original")]
            if before["task"]:
                history += [specification.chat.event("user", "context", before[name], name) for name in specification.chat.PRIOR_FIELDS]
            history += [specification.chat.event("user", "input", value["task"])]
            if current == "child-final":
                tool, outcome = specification.chat.once.expected_outcome(value)
                history += [specification.chat.event("model", "text", "", "qwen"),
                            specification.chat.event("model", "request", value.get("action_raw", specification.encoded(value["action"])), tool),
                            specification.chat.event("tool", "complete", outcome, tool)]
            assert context == {"history": history, "allowed": item["allowed"], "final_only": current == "child-final"}, "restored child prior changed or old tool replayed"
            assert specification.chat.child_prior(context) == before
            assert "at most one read-only tool" in request["messages"][0]["content"]
            role = "child"
        system = request["messages"][0]["content"]
        assert role not in systems or systems[role] == system
        systems[role] = system
    if value["kind"] == "success":
        assert records[-1]["phase"] == "aggregate" and records[-1]["response_text"] == selected["answer"]
    return {"contexts": [record["context"] for record in records], "expected_restored_prior": before,
            "selected": selected if value["kind"] == "success" else None}


def trace_observation(trace, model_case, records, memory, phase):
    assert trace.get("schema") == "etas.cli.interpreter-report.v1" and trace.get("incomplete") is not True
    assert trace["termination"]["local_work_settled"] is True
    started = [event for event in trace["events"] if event["kind"] == "host_request_started"]
    finished = {event["id"]: event for event in trace["events"] if event["kind"] == "host_request_finished"}
    events = [event for event in started if event.get("request_kind") == "memory"]
    assert all(event.get("qualified_action") in {"Memory.read", "Memory.write"} and event["id"] in finished for event in events)
    counts = (sum(event["qualified_action"] == "Memory.read" for event in events),
              sum(event["qualified_action"] == "Memory.write" for event in events))
    assert counts == tuple(memory), "Memory read/write counts differ from frozen protocol"
    ids = {event["id"] for event in events}
    view = dict(trace, events=[event for event in trace["events"] if not (event["kind"] in {"host_request_started", "host_request_finished"} and event["id"] in ids)])
    observed = chat.specification.assert_trace({"turns": []} if model_case is None else model_case, view, records)
    if model_case is None:
        assert not records and not observed["model_actions"] and not observed["file_actions"]
    if phase in {"show", "successor-show"}:
        assert counts[1] == 0
    if phase == "continue" and records:
        first_model = next(index for index, event in enumerate(started) if event in observed["model_actions"])
        before = [event["qualified_action"] for event in started[:first_model] if event in events]
        assert before == specification.ADMISSION_ACTIONS, "Model reached before confirmed admission and predecessor recheck"
        assert all(finished[event["id"]]["outcome"]["kind"] == "succeeded" for event in events if event in started[:first_model])
    return {**observed, "memory_actions": events, "memory_finished": [finished[event["id"]] for event in events], "memory_counts": counts}


def assert_successor(item, directory, predecessor, http):
    values = new_rows(directory)
    assert set(values) == {"admission:" + item["id"], "successor:" + item["successor"]}
    body = specification.body(item, predecessor["value"]["body"], predecessor["opaque_version"])
    usage = specification.chat.add(specification.prepared(item, "save")["ledger"], specification.prepared(item, "continue")["ledger"])
    for name, phase in [("admission:" + item["id"], "settled"), ("successor:" + item["successor"], "published")]:
        assert values[name]["value"] == expected_record(item, predecessor, phase, body=body, usage=usage, resolved=True), "published successor differs from actual completed turn/lineage/accounting"
    fields = json.loads(body)
    plan, aggregate = http[0], http[-1]
    assert fields[7] == plan["context"]["request"] and fields[8] == aggregate["context"]["task"]
    assert fields[9:13] == [aggregate["context"][key] for key in ["result", "tool", "outcome"]] + [aggregate["response_text"]]
    events = specification.records(item)
    assert events[1]["text"] == plan["response_text"]
    child = next(event for event in http if event["phase"] == ("child-final" if fields[10] else "child-first"))
    actual = child["context"]["history"] + [specification.chat.event("model", "text", "", "qwen"),
                                            specification.chat.event("assistant", "final", aggregate["context"]["result"])]
    assert events[3:3 + len(actual)] == actual, "successor records do not retain actual serialized selected-prior child history"
    assert specification.TOKEN not in body and fields[5] == predecessor["value"]["body"]
    return {"body": body, "fields": fields, "records": events, "rows": values, "usage": usage}


def trigger_sql(phase):
    assert phase in {"admitted", "settled", "pending", "published"}
    action = "UPDATE" if phase in {"settled", "published"} else "INSERT"
    return ("CREATE TRIGGER continuation_owned_test_block BEFORE " + action + " ON memory_entries WHEN NEW.region='" + specification.REGION
            + "' AND instr(NEW.value_json, '\"" + phase + "\"') > 0 BEGIN SELECT RAISE(ABORT, 'owned continuation publication refusal'); END")


def stale_version_trigger_sql():
    # Advance both values together so the normal Host accepts the store history.
    # This deliberate fixture mutation is not an Etas write/receipt observation.
    return ("CREATE TRIGGER continuation_owned_stale_predecessor AFTER INSERT ON memory_entries WHEN NEW.region='" + specification.REGION
            + "' AND instr(NEW.value_json, '\"admitted\"') > 0 BEGIN "
            + "UPDATE memory_stores SET revision=revision+1 WHERE region='" + specification.first.REGION + "'; "
            + "UPDATE memory_entries SET version=(SELECT revision FROM memory_stores WHERE region='" + specification.first.REGION
            + "' AND path=memory_entries.path) WHERE region='" + specification.first.REGION + "' AND instr(key_json, 'checkpoint:') > 0; END")


def corrupt_predecessor(item, directory, seed):
    target = old_rows(directory)["checkpoint:" + item["id"]]
    tagged = json.loads(target["value_json"])
    body = specification.first.corrupt_body(item, seed["first_fields"])
    next(field["value"] for field in tagged["fields"] if field["name"] == "body")["value"] = body
    sql = "UPDATE memory_entries SET value_json=? WHERE region=? AND path=? AND key_json=?"
    parameters = [specification.encoded(tagged), target["region"], target["path"], target["key_json"]]
    with sqlite3.connect(directory / "harness.sqlite3") as connection:
        assert connection.execute(sql, parameters).rowcount == 1
    return {"scope": "explicit fresh test-owned clone only", "sql": sql, "parameters": parameters}


def corrupt_successor(item, directory, seed):
    target = new_rows(directory)["successor:" + item["successor"]]
    tagged = json.loads(target["value_json"])
    if item["mutation"] == "envelope-phase":
        next(field["value"] for field in tagged["fields"] if field["name"] == "phase")["value"] = "pending"
    else:
        fields = list(seed["fields"])
        changes = {"wire-version": (0, "unsupported-successor-v2"), "usage-reset": (13, "0"),
                   "maximum-change": (18, "13"), "third-admitted": (23, "3"),
                   "prior-record": (27 + 5 * 4 + 3, "FORGED PRIOR RESULT"),
                   "opaque-version": (6, "FORGED VERSION"), "wrong-lineage": (1, "forged-successor")}
        index, value = changes[item["mutation"]]
        fields[index] = value
        next(field["value"] for field in tagged["fields"] if field["name"] == "body")["value"] = specification.encoded(fields)
    sql = "UPDATE memory_entries SET value_json=? WHERE region=? AND path=? AND key_json=?"
    parameters = [specification.encoded(tagged), target["region"], target["path"], target["key_json"]]
    with sqlite3.connect(directory / "harness.sqlite3") as connection:
        assert connection.execute(sql, parameters).rowcount == 1
    return {"scope": "explicit fresh test-owned clone only", "sql": sql, "parameters": parameters}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--etas")
    parser.add_argument("--fixture-root", type=Path, default=Path("/harness-tool-fixture"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    options = parser.parse_args()
    if not 1 <= options.timeout <= 240 or not options.fixture_root.is_absolute():
        parser.error("bounded timeout and absolute read-only synthetic fixture root required")
    if not options.prepare_only and (not options.etas or not Path(options.etas).is_absolute()):
        parser.error("actual execution requires selected absolute normal CLI")
    if not options.prepare_only:
        specification.configured()
    paths, cases = product_paths(), specification.cases()
    runner_paths = [Path(__file__).resolve(), FIXTURE, ROOT / "tests/harness_session_probe.py", previous.FIXTURE,
                    ROOT / "tests/harness_tool_chat_probe.py", ROOT / "tests/fixtures/harness_tool002a/cases.py",
                    ROOT / "tests/harness_tool_probe.py", ROOT / "tests/fixtures/harness_tool001/cases.py",
                    ROOT / "scripts/session-demo-001b-verify.py", ROOT / "tests/harness_model_probe.py",
                    ROOT / "tests/harness_chat_probe.py", ROOT / "tests/harness_entry_probe.py", ROOT / "tests/model_tool_probe.py",
                    ROOT / "tests/foundation_probe.py", ROOT / "tests/normal_graph_identity.py",
                    ROOT / "tests/fixtures/harness_model001/cases.py", chat.once.previous.graph_identity.bootstrap_path(),
                    ROOT / "config/etas-latest-main.json"]
    runner_paths += sorted(value for value in (chat.once.FIXTURE / "workspace").rglob("*") if value.is_file())
    frozen_product, frozen_runner = hashes(paths), hashes(runner_paths)
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == value or value in destination.parents for value in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("evidence must be persistent")
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness-session001b-", dir=destination))
    for source in paths + runner_paths:
        retain(source, evidence / "frozen-inputs" / source.relative_to(ROOT))
    save(evidence / "cases.json", cases)
    result = {"task": "HARNESS-SESSION-001B", "scope": "actual owned v1 save/new-process restored second turn/distinct successor/new-process data-only show",
              "status": "not_run", "prepared_only": options.prepare_only, "protocol_ready": specification.PROTOCOL_READY,
              "case_count": len(cases), "cases": [dict(item, status="not_run") for item in cases], "commands": [],
              "created_utc": datetime.now(timezone.utc).isoformat(), "product_sources_and_graph": frozen_product,
              "runner_inputs": frozen_runner, "cases_sha256": digest(evidence / "cases.json"), "cli_requested": options.etas,
              "ordinary_memory_limit_bytes": MEMORY_LIMIT}
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: construction only; no SQLite/server/CLI/Etas dispatch", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    fixture_before = snapshot(options.fixture_root)
    assert fixture_before == snapshot(chat.once.FIXTURE / "workspace")
    mount = next(line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[4] == str(options.fixture_root))
    assert "ro" in mount[5].split(",") and resources()["memory.max"] == str(MEMORY_LIMIT)
    result.update(status="running", cli_path=str(cli), cli_sha256=digest(cli), fixture_mount=mount, fixture_before=fixture_before)
    save(output, result)
    completed, failure = {}, None

    def invoke(item, project, directory, label, phase, expected, *, code=0, memory, arguments=None, attempted=False, predecessor=None, mutates=False):
        command_dir = evidence / "commands" / (str(len(result["commands"])).zfill(3) + "-" + label)
        command_dir.mkdir(parents=True)
        trace_path = command_dir / "trace.json"
        if arguments is None:
            arguments = (specification.arguments(item, phase) if phase in {"continue", "successor-show"}
                         else specification.first.arguments(specification.first_case(item), saving=phase == "save"))
        argv = [str(cli), "run", str(project), "--flow", FLOWS[phase], "--profile", PROFILES[phase],
                "--allow-effects", "--trace-out", str(trace_path), "--args", *arguments]
        before = previous.inspect(directory)
        inputs = {str(value.relative_to(project)): digest(value) for value in project.rglob("*") if value.is_file()}
        model_phase = phase in {"save", "continue"}
        model = specification.model_case(item, phase, attempted) if model_phase else None
        command = {"label": label, "phase": phase, "command": argv, "cwd": str(directory), "expected_exit": code,
                   "expected_stdout": expected, "expected_memory": memory, "status": "running", "inputs": inputs,
                   "database_before": before, "server_started": model_phase, "resources_before": resources(),
                   "started_utc": datetime.now(timezone.utc).isoformat()}
        result["commands"].append(command)
        for name, value in [("argv", argv), ("inputs", inputs), ("case", item)]:
            save(command_dir / (name + ".json"), value)
        (command_dir / "stdin.bin").write_bytes(b"")
        save(output, result)
        assert command["resources_before"]["memory.max"] == str(MEMORY_LIMIT)
        assert hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        started = time.monotonic()
        stdout, stderr, exit_code, timed_out, http, pid, admission = run_process(argv, directory, model, options.timeout,
                                                                               phase=phase, item=item, predecessor=predecessor)
        for name, raw in [("stdout", stdout), ("stderr", stderr)]:
            target = command_dir / (name + ".bin")
            target.write_bytes(raw)
            command.update({name + "_base64": base64.b64encode(raw).decode("ascii"), name + "_sha256": digest(target),
                            name + "_retained": str(target.relative_to(evidence))})
        save(command_dir / "http-observations.json", http)
        save(command_dir / "admission-observations.json", admission)
        after = previous.inspect(directory)
        command.update(exit=exit_code, timeout=timed_out, pid=pid, actual_http_count=len(http), database_after=after,
                       resources_after=resources(), status="observed", http_retained=str((command_dir / "http-observations.json").relative_to(evidence)),
                       http_sha256=digest(command_dir / "http-observations.json"), admission_observations=admission,
                       admission_retained=str((command_dir / "admission-observations.json").relative_to(evidence)),
                       admission_sha256=digest(command_dir / "admission-observations.json"),
                       elapsed_seconds=time.monotonic() - started, finished_utc=datetime.now(timezone.utc).isoformat())
        if trace_path.is_file():
            command.update(trace_sha256=digest(trace_path), trace_retained=str(trace_path.relative_to(evidence)))
        save(output, result)
        assert not timed_out and exit_code == code and stdout == expected.encode(), "actual process exit/complete transcript differs"
        if code:
            if attempted and phase == "continue" and item["second"]["kind"] == "host_abort":
                assert stderr and b"Nomo Harness checkpoint continue refused" not in stderr
            else:
                wrapper = "Nomo Harness successor show refused; see REFUSED output" if phase == "successor-show" else "Nomo Harness checkpoint " + phase + " refused; see REFUSED output"
                assert b"analysis::ExecutionAborted" in stderr and wrapper.encode() in stderr
        else:
            assert not stderr
        assert specification.TOKEN.encode() not in stdout + stderr and admission["error"] is None
        command.update(trace_observation(json.loads(trace_path.read_text()), model, http, memory, phase))
        if model is not None and attempted:
            command.update(assert_http(item, phase, http))
        if phase == "continue" and http:
            assert len(admission["observations"]) == len(http), "missing independently observed durable admission"
        if phase in {"show", "successor-show"} or not attempted and phase == "continue" and not mutates:
            assert before == after, "show/pre-dispatch refusal mutated logical storage"
        assert hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        assert all((project / name).is_file() and digest(project / name) == value for name, value in inputs.items())
        assert snapshot(options.fixture_root) == fixture_before
        assert command["resources_after"]["memory.max"] == str(MEMORY_LIMIT) and pressure(command["resources_before"]) == pressure(command["resources_after"])
        command["status"] = "passed"
        save(output, result)
        print("PASS " + label + " HTTP=" + str(len(http)) + " Memory=" + str(memory), flush=True)
        return command, http

    try:
        for item in result["cases"]:
            directory = evidence / "stores" / item["label"]
            directory.mkdir(parents=True, mode=0o700)
            assert not directory.is_symlink() and directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o077 == 0
            project = evidence / "projects" / item["label"]
            for source in paths:
                if source.name != "etas.toml":
                    retain(source, project / source.relative_to(ROOT))
            (project / "etas.toml").write_text(previous.manifest(item, directory, options.fixture_root))
            assert {str(value.relative_to(project)): digest(value) for value in (project / "src").rglob("*.es")} == {name: value for name, value in frozen_product.items() if name.startswith("src/")}
            if item["kind"] == "corrupt_successor":
                seed = completed[item["seed"]]
                previous.clone_database(Path(seed["published_directory"]), directory)
                item["test_mutation"] = corrupt_successor(item, directory, seed)
                save(evidence / (item["label"] + "-mutation.json"), item["test_mutation"])
                invoke(item, project, directory, item["label"] + "-successor-show", "successor-show", "REFUSED " + item["diagnostic"] + "\n",
                       code=3, memory=(5, 0))
            elif item["kind"] == "corrupt_predecessor":
                seed = completed[item["seed"]]
                previous.clone_database(Path(seed["predecessor_directory"]), directory)
                item["test_mutation"] = corrupt_predecessor(item, directory, seed)
                save(evidence / (item["label"] + "-mutation.json"), item["test_mutation"])
                invoke(item, project, directory, item["label"] + "-continue", "continue", "REFUSED " + item["diagnostic"] + "\n",
                       code=3, memory=specification.MEMORY["corrupt_predecessor"])
                assert not new_rows(directory)
            else:
                invoke(item, project, directory, item["label"] + "-init", "init", "INITIALIZED Harness checkpoint owner " + item["id"] + "\n", memory=(3, 1))
                saved, first_http = invoke(item, project, directory, item["label"] + "-save", "save",
                                          specification.first.save_stdout(specification.first_case(item)), memory=(7, 3), attempted=True)
                first_body = specification.first.body(specification.first_case(item))
                old_snapshot = old_rows(directory)
                predecessor = old_snapshot["checkpoint:" + item["id"]]
                assert predecessor["value"] == previous.expected_record(item, "published", first_body)
                assert json.loads(first_body) == specification.first.body_fields(specification.first_case(item))
                seed_directory = evidence / "predecessors" / item["label"]
                seed_directory.mkdir(parents=True, mode=0o700)
                previous.clone_database(directory, seed_directory)
                if item["kind"] == "write_failure":
                    sql = trigger_sql(item["trigger"])
                    with sqlite3.connect(directory / "harness.sqlite3") as connection:
                        connection.execute(sql)
                    item["test_trigger"] = sql
                if item["kind"] == "stale_version":
                    sql = stale_version_trigger_sql()
                    with sqlite3.connect(directory / "harness.sqlite3") as connection:
                        connection.execute(sql)
                    item["test_trigger"] = sql
                key = ("continue_success" if item["kind"] == "roundtrip" else "continue_" + item["trigger"] if item["kind"] == "write_failure"
                       else item["kind"] if item["kind"] in {"preflight_failure", "stale_version"} else "continue_abort" if item["second"]["kind"] == "host_abort" else "continue_failure")
                attempted = item.get("trigger") != "admitted" and item["kind"] not in {"preflight_failure", "stale_version"}
                continued, http = invoke(item, project, directory, item["label"] + "-continue", "continue", specification.continue_stdout(item),
                                         code=0 if item["kind"] == "roundtrip" else 3, memory=specification.MEMORY[key],
                                         attempted=attempted, predecessor=predecessor, mutates=item["kind"] == "stale_version")
                assert saved["pid"] != continued["pid"]
                if item["kind"] != "stale_version":
                    assert old_rows(directory) == old_snapshot
                if item["kind"] == "roundtrip":
                    observed = assert_successor(item, directory, predecessor, http)
                    shown, _ = invoke(item, project, directory, item["label"] + "-successor-show", "successor-show", "SUCCESSOR " + observed["body"] + "\n",
                                      memory=specification.MEMORY["successor_show"])
                    assert shown["pid"] not in {saved["pid"], continued["pid"]} and not shown["server_started"]
                    completed[item["label"]] = dict(observed, predecessor_directory=str(seed_directory), published_directory=str(directory), first_fields=json.loads(first_body),
                                                   contexts=continued["contexts"], first_contexts=saved["contexts"], first_http=first_http)
                elif item["kind"] == "stale_version":
                    with sqlite3.connect((directory / "harness.sqlite3").as_uri() + "?mode=ro", uri=True) as connection:
                        actual = connection.execute("SELECT value_json FROM memory_entries WHERE region=?", [specification.REGION]).fetchall()
                        changed = connection.execute("SELECT value_json,version FROM memory_entries WHERE region=? AND key_json=?",
                                                     [predecessor["region"], predecessor["key_json"]]).fetchone()
                    assert len(actual) == 1 and storage.untag(json.loads(actual[0][0])) == expected_record(item, predecessor, "admitted")
                    assert changed[0] == predecessor["value_json"] and changed[1] == predecessor["version"] + 1
                    invoke(item, project, directory, item["label"] + "-successor-show", "successor-show",
                           "REFUSED successor missing; no completed continuation\n", code=3, memory=(5, 0))
                else:
                    values = new_rows(directory)
                    if item.get("trigger") == "admitted" or item["kind"] == "preflight_failure":
                        assert not values
                    else:
                        expected_phase = "admitted" if item["second"]["kind"] == "host_abort" or item.get("trigger") == "settled" else "failed" if item["kind"] == "turn_failure" else "settled"
                        admitted = values["admission:" + item["id"]]["value"]
                        assert admitted["phase"] == expected_phase and admitted["predecessor_body"] == first_body
                        assert admitted["predecessor_version"] == predecessor["opaque_version"]
                        assert admitted["admitted"] == 2 and admitted["resolved"] == (expected_phase != "admitted")
                        expected_usage = (specification.prepared(item, "save")["ledger"] if expected_phase == "admitted" else
                                          specification.chat.add(specification.prepared(item, "save")["ledger"], specification.prepared(item, "continue")["ledger"]))
                        assert admitted["usage"] == ledger(expected_usage), "failed/aborted turn reset or invented settled charges"
                        assert admitted["maximum"] == ledger(specification.MAXIMUM)
                        assert admitted["reserved"] == ledger([7, 4, 8192, 1, 4096] if expected_phase == "admitted" else [0] * 5)
                        assert set(values) == ({"admission:" + item["id"], "successor:" + item["successor"]} if item.get("trigger") == "published" else {"admission:" + item["id"]})
                    diagnostic, reads = specification.failed_show(item)
                    invoke(item, project, directory, item["label"] + "-successor-show", "successor-show", "REFUSED " + diagnostic + "\n", code=3, memory=(reads, 0))
                invoke(item, project, directory, item["label"] + "-predecessor-show", "show", "CHECKPOINT " + first_body + "\n", memory=(3, 0))
                if item.get("trigger") != "admitted" and item["kind"] != "preflight_failure":
                    invoke(item, project, directory, item["label"] + "-repeat-continue", "continue", "REFUSED " + specification.DUPLICATE_DIAGNOSTIC + "\n",
                           code=3, memory=specification.MEMORY["duplicate"])
                    invoke(item, project, directory, item["label"] + "-changed-successor-repeat", "continue", "REFUSED " + specification.DUPLICATE_DIAGNOSTIC + "\n",
                           code=3, memory=specification.MEMORY["duplicate"], arguments=specification.arguments(item, "continue", successor="other-successor"))
                if item["label"] == "continuation-prior-alpha-no-replay":
                    for field, value, diagnostic, memory in specification.BINDING_REFUSALS:
                        args = specification.arguments(item, "continue", **{field: value})
                        invoke(item, project, directory, item["label"] + "-wrong-" + field, "continue", "REFUSED " + diagnostic + "\n", code=3,
                               memory=memory, arguments=args)
                    invoke(item, project, directory, item["label"] + "-third-turn", "continue", "REFUSED checkpoint owner or phase mismatch; no retry\n", code=3,
                           memory=(1, 0), arguments=specification.arguments(item, "continue", id=item["successor"], successor="forbidden-third"))
                if item["label"] == "continuation-search-two-recall":
                    invoke(item, project, directory, item["label"] + "-reversed-allowlist", "continue", "REFUSED checkpoint owner or phase mismatch; no retry\n",
                           code=3, memory=(1, 0), arguments=specification.arguments(item, "continue", allow="docs/b.txt,docs/a.txt"))
                if item["kind"] != "stale_version":
                    assert old_rows(directory) == old_snapshot, "continuation changed original owner/publication/version/body"
            item["status"] = "passed"
            save(output, result)
        alpha, beta = completed["continuation-prior-alpha-no-replay"], completed["continuation-prior-beta-no-replay"]
        assert alpha["contexts"][0]["request"] == beta["contexts"][0]["request"]
        assert alpha["contexts"][0]["allowed"] == beta["contexts"][0]["allowed"]
        for name in ["result", "outcome", "answer"]:
            assert alpha["contexts"][0]["prior"][name] != beta["contexts"][0]["prior"][name]
        assert alpha["fields"][8] != beta["fields"][8] and alpha["fields"][9] != beta["fields"][9] and alpha["fields"][12] != beta["fields"][12]
        assert alpha["usage"] == beta["usage"] == [12, 7, 14336, 1, 4096]
        result.update(cross_process_prior_dependence_proved=True, prior_tool_not_replayed=True, predecessor_preserved=True)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "item" in locals():
            item.update(status="failed", failure=failure)
        if result["commands"] and result["commands"][-1]["status"] != "passed":
            result["commands"][-1].update(status="failed", failure=failure)
    finally:
        unchanged = hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        result.update(status="passed" if not failure and all(item["status"] == "passed" for item in result["cases"]) and unchanged else "failed",
                      protected_inputs_unchanged=unchanged, fixture_after=snapshot(options.fixture_root),
                      cli_unchanged=digest(cli) == result["cli_sha256"], finished_utc=datetime.now(timezone.utc).isoformat())
        if result["fixture_after"] != fixture_before or not result["cli_unchanged"]:
            result["status"] = "failed"
        if failure:
            result["failure"] = failure
        save(output, result)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
