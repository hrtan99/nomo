#!/usr/bin/env python3
"""Actual normal-CLI Harness init/save/independent-show SQLite observations.

Only fresh owned directories and explicit cloned synthetic databases are changed.
Python supplies protocol replies, corrupt fixture data and independent SQL reads;
all checkpoint admission, publication and reload validation run in real Etas.
"""
import argparse
import base64
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import tomllib

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import harness_tool_chat_probe as chat

FIXTURE = ROOT / "tests/fixtures/harness_session001/cases.py"
specification = chat.once.load("checkpoint_exact_cases", FIXTURE)
storage = chat.once.load("accepted_normal_storage_observer", ROOT / "scripts/session-demo-001b-verify.py")
storage.DB_NAMES = ("harness.sqlite3",)
digest, save, retain = chat.digest, chat.save, chat.retain
resources, pressure, snapshot = chat.resources, chat.pressure, chat.snapshot
MEMORY_LIMIT = chat.MEMORY_LIMIT
PROFILES = {"init": "harness-checkpoint-create", "save": "harness-checkpoint-save", "show": "harness-checkpoint-show"}


def product_paths():
    paths = sorted((ROOT / "src").rglob("*.es"))
    if len(paths) != 48 or any(path.name.startswith("model_session") for path in paths):
        raise ValueError("actual complete isolated 48-module checkpoint product required")
    return paths + [ROOT / "etas.toml", ROOT / "etas.lock"]


def hashes(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def inspect(directory):
    logical, raw = storage.inspect_store(directory)
    return {"logical": logical, "dump": raw}


def rows(directory):
    path = directory / "harness.sqlite3"
    if not path.exists():
        return {}
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
        values = connection.execute("SELECT region,path,key_json,value_json,version FROM memory_entries ORDER BY key_json").fetchall()
    result = {}
    for region, store_path, key, value, version in values:
        assert region == specification.REGION and json.loads(store_path) == ["Rows"], "checkpoint escaped its exact namespace"
        name = storage.untag(json.loads(key))
        assert name not in result, "duplicate checkpoint row"
        result[name] = {"region": region, "path": store_path, "key_json": key, "value_json": value,
                        "value": storage.untag(json.loads(value)), "version": version}
    return result


def manifest(item, directory, fixture_root):
    text = chat.manifest(item, fixture_root)
    target = directory / "harness.sqlite3"
    text = text.replace('path = "harness.sqlite3"', "path = " + specification.encoded(str(target)))
    text = text.replace('path = "file:harness.sqlite3?mode=rw"', "path = " + specification.encoded("file:" + str(target) + "?mode=rw"))
    profiles = tomllib.loads(text)["runtime"]["profiles"]
    for phase in ["init", "show"]:
        profile = profiles[PROFILES[phase]]
        assert "model" not in profile and "filesystem" not in profile and "session" not in profile
        assert profile["policy"] == {"mode": "local-static", "rules": ["console=allow", "memory=allow"]}
        assert profile["approval"] == {"mode": "deny"}
    assert profiles[PROFILES["init"]]["memory"] == {"backend": "sqlite", "path": str(target)}
    for phase in ["save", "show"]:
        assert profiles[PROFILES[phase]]["memory"] == {"backend": "sqlite", "path": "file:" + str(target) + "?mode=rw"}
    assert profiles[PROFILES["save"]]["model"]["base_url"] == "http://127.0.0.1:" + str(chat.PORT) + "/v1"
    assert profiles[PROFILES["save"]]["model"]["retry"] == {"attempts": 1, "delay_ms": 0}
    assert profiles[PROFILES["save"]]["filesystem"]["regions"] == {"nomo.tools.workspace.ReadOnlyRoot": {
        "root": str(fixture_root / item["variant"]), "read": True, "write": False}}
    return text


def run_process(argv, directory, model_case, timeout):
    """Each command is a real separate process; no server exists for init/show."""
    server = thread = None
    environment = dict(os.environ)
    if model_case is not None:
        server = ThreadingHTTPServer(("127.0.0.1", chat.PORT), chat.Handler)
        server.daemon_threads = True
        server.item, server.records, server.turn, server.lock = model_case, [], -1, threading.Lock()
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
    return stdout, stderr, process.returncode, timed_out, records, process.pid


def trace_observation(trace, model_case, records, memory):
    assert trace.get("schema") == "etas.cli.interpreter-report.v1" and trace.get("incomplete") is not True
    assert trace["termination"]["local_work_settled"] is True
    started = [value for value in trace["events"] if value["kind"] == "host_request_started"]
    completed = {value["id"]: value for value in trace["events"] if value["kind"] == "host_request_finished"}
    memory_events = [value for value in started if value.get("request_kind") == "memory"]
    assert all(value.get("qualified_action") in {"Memory.read", "Memory.write"} for value in memory_events)
    assert sum(value["qualified_action"] == "Memory.read" for value in memory_events) == memory[0]
    assert sum(value["qualified_action"] == "Memory.write" for value in memory_events) == memory[1]
    assert all(value["id"] in completed for value in memory_events), "Memory result missing"
    ids = {value["id"] for value in memory_events}
    view = dict(trace, events=[value for value in trace["events"] if not (value["kind"] in {"host_request_started", "host_request_finished"} and value["id"] in ids)])
    empty = {"turns": []}
    model = chat.specification.assert_trace(empty if model_case is None else model_case, view, records)
    if model_case is None:
        assert not records and not model["model_actions"] and not model["file_actions"], "data-only process replayed Model/File"
    elif model_case["turns"]:
        services = [value["qualified_action"] for value in started if value in memory_events or value in model["model_actions"] or value in model["file_actions"]]
        assert services[:4] == ["Memory.read", "Memory.read", "Memory.write", "Memory.read"], "Model started before confirmed ownership consumption"
    return {**model, "memory_actions": memory_events, "memory_finished": [completed[value["id"]] for value in memory_events]}


def expected_record(item, phase, body=""):
    return {"format": 1, "phase": phase, "identity": {"id": item["id"], "workspace": item["workspace"], "allowed": item["allowed"]}, "body": body}


def assert_saved(item, directory, http):
    values = rows(directory)
    assert set(values) == {"owner", "checkpoint:" + item["id"]}
    assert values["owner"]["value"] == expected_record(item, "claimed") and values["owner"]["version"] == 2
    row = values["checkpoint:" + item["id"]]
    assert row["value"] == expected_record(item, "published", specification.body(item)) and row["version"] == 4
    fields = json.loads(row["value"]["body"])
    assert fields == specification.body_fields(item), "stored checkpoint differs from independent complete transcript/ledger"
    plan, aggregate = http[0], http[-1]
    assert fields[5] == plan["context"]["request"] and fields[6] == aggregate["context"]["task"] and fields[5] != fields[6]
    assert fields[7:11] == [aggregate["context"][key] for key in ["result", "tool", "outcome"]] + [aggregate["response_text"]]
    actual_records = specification.records(item)
    assert actual_records[1]["text"] == plan["response_text"], "raw main plan was reconstructed or discarded"
    child_final = next(value for value in http if value["phase"] == ("child-final" if fields[8] else "child-first"))
    history = child_final["context"]["history"] + [specification.chat.event("model", "text", "", "qwen"),
                                                    specification.chat.event("assistant", "final", aggregate["context"]["result"])]
    assert actual_records[3:3 + len(history)] == history, "persisted child history is not associated with actual Model/File observations"
    assert specification.TOKEN not in row["value"]["body"]
    return {"body": row["value"]["body"], "fields": fields, "records": actual_records, "rows": values}


def clone_database(source, destination):
    assert not (destination / "harness.sqlite3").exists()
    with sqlite3.connect((source / "harness.sqlite3").as_uri() + "?mode=ro", uri=True) as old:
        with sqlite3.connect(destination / "harness.sqlite3") as new:
            old.backup(new)
    assert inspect(source) == inspect(destination), "owned clone is not the exact source database"


def mutate(item, directory, baseline):
    values = rows(directory)
    name = "owner" if item["mutation"] == "owner-ready" else "checkpoint:" + item["id"]
    target = values[name]
    tagged = json.loads(target["value_json"])
    field = "phase" if item["mutation"] in {"pending", "owner-ready"} else "format" if item["mutation"] == "envelope-format" else "body"
    data = "ready" if item["mutation"] == "owner-ready" else "pending" if field == "phase" else 2 if field == "format" else specification.corrupt_body(item, baseline["fields"])
    node = next(value["value"] for value in tagged["fields"] if value["name"] == field)
    node["value"] = str(data) if isinstance(node["value"], str) else data
    sql = "UPDATE memory_entries SET value_json=? WHERE region=? AND path=? AND key_json=?"
    parameters = [specification.encoded(tagged), target["region"], target["path"], target["key_json"]]
    with sqlite3.connect(directory / "harness.sqlite3") as connection:
        assert connection.execute(sql, parameters).rowcount == 1
    return {"scope": "test-only corrupt data in an explicit fresh owned clone", "sql": sql, "parameters": parameters}


def trigger_sql(phase):
    assert phase in {"pending", "published"}
    action = "INSERT" if phase == "pending" else "UPDATE"
    return "CREATE TRIGGER checkpoint_test_block BEFORE " + action + " ON memory_entries WHEN instr(NEW.value_json, '\"" + phase + "\"') > 0 BEGIN SELECT RAISE(ABORT, 'owned test publication refusal'); END"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--etas")
    parser.add_argument("--fixture-root", type=Path, default=Path("/harness-tool-fixture"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    options = parser.parse_args()
    if not options.prepare_only:
        specification.configured()
    if not 1 <= options.timeout <= 240 or not options.fixture_root.is_absolute():
        parser.error("bounded timeout and absolute read-only workspace root required")
    if not options.prepare_only and (not options.etas or not Path(options.etas).is_absolute()):
        parser.error("actual execution requires the selected absolute normal CLI")
    paths, cases = product_paths(), specification.cases()
    runner_paths = [Path(__file__).resolve(), FIXTURE, ROOT / "tests/harness_tool_chat_probe.py", ROOT / "tests/fixtures/harness_tool002a/cases.py",
                    ROOT / "tests/harness_tool_probe.py", ROOT / "tests/fixtures/harness_tool001/cases.py", ROOT / "scripts/session-demo-001b-verify.py",
                    ROOT / "tests/harness_model_probe.py", ROOT / "tests/harness_chat_probe.py", ROOT / "tests/harness_entry_probe.py",
                    ROOT / "tests/model_tool_probe.py", ROOT / "tests/foundation_probe.py", ROOT / "tests/normal_graph_identity.py",
                    ROOT / "tests/fixtures/harness_model001/cases.py", chat.once.previous.graph_identity.bootstrap_path(), ROOT / "config/etas-latest-main.json"]
    runner_paths += sorted(value for value in (chat.once.FIXTURE / "workspace").rglob("*") if value.is_file())
    frozen_product, frozen_runner = hashes(paths), hashes(runner_paths)
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == value or value in destination.parents for value in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("evidence must be persistent")
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness-session001-", dir=destination))
    for source in paths + runner_paths:
        retain(source, evidence / "frozen-inputs" / source.relative_to(ROOT))
    save(evidence / "cases.json", cases)
    result = {"task": "HARNESS-SESSION-001A", "scope": "actual normal Memory SQLite init/save/separate-process data-only show",
              "status": "not_run", "prepared_only": options.prepare_only, "case_count": len(cases), "commands": [],
              "protocol_ready": specification.PROTOCOL_READY, "created_utc": datetime.now(timezone.utc).isoformat(),
              "product_sources_and_graph": frozen_product, "runner_inputs": frozen_runner, "cases_sha256": digest(evidence / "cases.json"),
              "cli_requested": options.etas, "ordinary_memory_limit_bytes": MEMORY_LIMIT, "cases": [dict(value, status="not_run") for value in cases]}
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: construction only; no SQLite store, server, CLI or Etas dispatch", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    fixture_before = snapshot(options.fixture_root)
    assert fixture_before == snapshot(chat.once.FIXTURE / "workspace")
    mount = next(line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[4] == str(options.fixture_root))
    assert "ro" in mount[5].split(",") and resources()["memory.max"] == str(MEMORY_LIMIT)
    result.update(status="running", cli_path=str(cli), cli_sha256=digest(cli), fixture_mount=mount, fixture_before=fixture_before)
    save(output, result)
    completed = {}
    failure = None

    def invoke(item, project, directory, label, phase, expected, *, code=0, memory=(0, 0), arguments=None, attempted=False):
        command_dir = evidence / "commands" / (str(len(result["commands"])).zfill(3) + "-" + label)
        command_dir.mkdir(parents=True)
        trace_path = command_dir / "trace.json"
        args = specification.arguments(item, phase == "save") if arguments is None else arguments
        argv = [str(cli), "run", str(project), "--flow", "harness_checkpoint_" + phase, "--profile", PROFILES[phase],
                "--allow-effects", "--trace-out", str(trace_path), "--args", *args]
        before = inspect(directory)
        inputs = {str(value.relative_to(project)): digest(value) for value in project.rglob("*") if value.is_file()}
        command = {"label": label, "phase": phase, "command": argv, "cwd": str(directory), "expected_exit": code,
                   "expected_stdout": expected, "status": "running", "inputs": inputs, "database_before": before,
                   "server_started": phase == "save", "resources_before": resources(), "started_utc": datetime.now(timezone.utc).isoformat()}
        result["commands"].append(command)
        for name, value in [("argv", argv), ("inputs", inputs), ("case", item)]:
            save(command_dir / (name + ".json"), value)
        (command_dir / "stdin.bin").write_bytes(b"")
        save(output, result)
        assert command["resources_before"]["memory.max"] == str(MEMORY_LIMIT) and hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        model = specification.model_case(item, attempted=attempted) if phase == "save" else None
        started = time.monotonic()
        stdout, stderr, exit_code, timed_out, http, pid = run_process(argv, directory, model, options.timeout)
        for name, raw in [("stdout", stdout), ("stderr", stderr)]:
            target = command_dir / (name + ".bin")
            target.write_bytes(raw)
            command.update({name + "_base64": base64.b64encode(raw).decode("ascii"), name + "_sha256": digest(target), name + "_retained": str(target.relative_to(evidence))})
        save(command_dir / "http-observations.json", http)
        after = inspect(directory)
        command.update(exit=exit_code, timeout=timed_out, pid=pid, actual_http_count=len(http), database_after=after,
                       resources_after=resources(), status="observed", http_retained=str((command_dir / "http-observations.json").relative_to(evidence)))
        command.update(elapsed_seconds=time.monotonic() - started, http_sha256=digest(command_dir / "http-observations.json"),
                       finished_utc=datetime.now(timezone.utc).isoformat())
        if trace_path.is_file():
            command.update(trace_sha256=digest(trace_path), trace_retained=str(trace_path.relative_to(evidence)))
        save(output, result)
        assert not timed_out and exit_code == code and stdout == expected.encode(), "actual process exit/checkpoint transcript differs"
        if code:
            if phase == "save" and attempted and item["turn"]["kind"] == "host_abort":
                assert stderr and b"Nomo Harness checkpoint save refused" not in stderr
            else:
                assert b"analysis::ExecutionAborted" in stderr and ("Nomo Harness checkpoint " + phase + " refused; see REFUSED output").encode() in stderr
        else:
            assert not stderr
        assert specification.TOKEN.encode() not in stdout + stderr
        observed = trace_observation(json.loads(trace_path.read_text()), model, http, memory)
        if model is not None:
            command.update(chat.specification.assert_http(model, http))
        command.update(observed)
        if phase == "show" or label.endswith("repeat-init") or label.endswith("repeat-save"):
            assert before == after, "read/refused operation changed logical schema/rows/receipts"
        assert all((project / name).is_file() and digest(project / name) == value for name, value in inputs.items())
        assert hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner and snapshot(options.fixture_root) == fixture_before
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
            (project / "etas.toml").write_text(manifest(item, directory, options.fixture_root))
            assert {str(value.relative_to(project)): digest(value) for value in (project / "src").rglob("*.es")} == {name: value for name, value in frozen_product.items() if name.startswith("src/")}
            if item["kind"] == "corrupt":
                seed = completed[item["seed"]]
                clone_database(Path(seed["directory"]), directory)
                item["test_mutation"] = mutate(item, directory, seed)
                save(evidence / (item["label"] + "-mutation.json"), item["test_mutation"])
                reads = 1 if item["mutation"] == "owner-ready" else 2
                invoke(item, project, directory, item["label"] + "-show", "show", "REFUSED " + item["diagnostic"] + "\n", code=3, memory=(reads, 0))
            else:
                invoke(item, project, directory, item["label"] + "-init", "init", "INITIALIZED Harness checkpoint owner " + item["id"] + "\n", memory=(3, 1))
                assert rows(directory)["owner"]["value"] == expected_record(item, "ready")
                if item["label"] == "checkpoint-read-alpha":
                    invoke(item, project, directory, item["label"] + "-show-before-save", "show", "REFUSED checkpoint owner or phase mismatch; no retry\n", code=3, memory=(1, 0))
                if item["kind"] == "publication_failure":
                    sql = trigger_sql(item["trigger"])
                    with sqlite3.connect(directory / "harness.sqlite3") as connection:
                        connection.execute(sql)
                    connection.close()
                    item["test_trigger"] = sql
                memory = (7, 3) if item["kind"] == "roundtrip" else (3, 1) if item["kind"] == "turn_failure" else (5, 2) if item["trigger"] == "pending" else (6, 3)
                command, http = invoke(item, project, directory, item["label"] + "-save", "save", specification.save_stdout(item),
                                       code=0 if item["kind"] == "roundtrip" else 3, memory=memory, attempted=True)
                if item["kind"] == "roundtrip":
                    observed = assert_saved(item, directory, http)
                    shown, _ = invoke(item, project, directory, item["label"] + "-show", "show", "CHECKPOINT " + observed["body"] + "\n", memory=(3, 0))
                    assert shown["pid"] != command["pid"] and not shown["server_started"]
                    completed[item["label"]] = dict(observed, directory=str(directory))
                    item["saved"] = observed
                else:
                    actual = rows(directory)
                    assert actual["owner"]["value"] == expected_record(item, "claimed")
                    pending = item.get("trigger") == "published"
                    assert set(actual) == ({"owner", "checkpoint:" + item["id"]} if pending else {"owner"})
                    if pending:
                        assert actual["checkpoint:" + item["id"]]["value"] == expected_record(item, "pending", specification.body(item))
                    diagnostic = "checkpoint not published; no recovery or retry" if pending else "checkpoint missing; no completed save"
                    invoke(item, project, directory, item["label"] + "-show", "show", "REFUSED " + diagnostic + "\n", code=3, memory=(2, 0))
                invoke(item, project, directory, item["label"] + "-repeat-save", "save", "REFUSED checkpoint owner or phase mismatch; no retry\n", code=3, memory=(1, 0))
                if item["label"] == "checkpoint-read-alpha":
                    invoke(item, project, directory, item["label"] + "-repeat-init", "init", "REFUSED checkpoint store already claimed\n", code=3, memory=(1, 0))
                    for field, value in [("id", "wrong-id"), ("workspace", "wrong-workspace"), ("allow", "docs/b.txt")]:
                        invoke(item, project, directory, item["label"] + "-wrong-" + field, "show", "REFUSED checkpoint owner or phase mismatch; no retry\n", code=3,
                               memory=(1, 0), arguments=specification.arguments(item, **{field: value}))
            item["status"] = "passed"
            save(output, result)
        alpha, beta = completed["checkpoint-read-alpha"], completed["checkpoint-read-beta"]
        for index in [7, 9, 10]:
            assert alpha["fields"][index] != beta["fields"][index], "actual File/child/parent change was not preserved"
        assert alpha["fields"][:7] == beta["fields"][:7] and alpha["fields"][11:25] == beta["fields"][11:25]
        result["cross_process_byte_dependence_proved"] = True
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "item" in locals():
            item.update(status="failed", failure=failure)
        if result["commands"] and result["commands"][-1]["status"] != "passed":
            result["commands"][-1].update(status="failed", failure=failure)
    finally:
        unchanged = hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        result.update(status="passed" if not failure and all(value["status"] == "passed" for value in result["cases"]) and unchanged else "failed",
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
