#!/usr/bin/env python3
"""Actual native lifecycle entry tests on fresh owned synthetic SQLite stores.

The observer reuses accepted HTTP/transcript/storage oracles. Etas executes the
new public entry, accepted turns, durable admission and exact publication.
Dedicated help/topics and show have no Model/File provider tables or model
server. Other argument checks use configured normal profiles, a fresh ready
owned store, a synthetic API key and no server; they must issue no Host actions
beyond Console/Policy. Native setup readiness is not bypassed or called a parse.
"""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import tomllib

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import harness_continuation_probe as accepted

previous, chat = accepted.previous, accepted.chat
FIXTURE = ROOT / "tests/fixtures/cli002a/cases.py"
specification = chat.once.load("native_lifecycle_cases", FIXTURE)
digest, save, retain = accepted.digest, accepted.save, accepted.retain
resources, pressure, snapshot = accepted.resources, accepted.pressure, accepted.snapshot


def product_paths():
    paths = sorted((ROOT / "src").rglob("*.es"))
    if len(paths) != specification.SOURCE_MODULES or any(path.name.startswith("model_session") for path in paths):
        raise ValueError("complete isolated public-lifecycle source required")
    return paths + [ROOT / "etas.toml", ROOT / "etas.lock"]


def hashes(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def no_provider_tables(text):
    """Remove all Model/File setup in the test manifest, preserving bin/profile mapping."""
    output, skip = [], False
    for line in text.splitlines():
        if line.startswith("["):
            skip = re.match(r"^\[runtime\.profiles\.[^.]+\.(model|filesystem)([.\]])", line) is not None
        if not skip:
            output.append(line)
    value = "\n".join(output) + "\n"
    assert all("model" not in profile and "filesystem" not in profile for profile in tomllib.loads(value)["runtime"]["profiles"].values())
    return value


def manifest(item, directory, fixture_root, *, readonly=False):
    text = previous.manifest(item, directory, fixture_root)
    if readonly:
        text = no_provider_tables(text)
    bins = tomllib.loads(text)["bin"]
    for action, flow in specification.FLOWS.items():
        matches = [value for value in bins if value["flow"] == flow]
        assert len(matches) == 1 and matches[0]["profile"] == specification.PROFILES[action]
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--etas")
    parser.add_argument("--fixture-root", type=Path, default=Path("/harness-tool-fixture"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    options = parser.parse_args()
    if not 1 <= options.timeout <= 240 or not options.fixture_root.is_absolute():
        parser.error("bounded timeout and absolute immutable fixture required")
    if not options.prepare_only:
        if not options.etas or not Path(options.etas).is_absolute():
            parser.error("actual run requires selected absolute normal CLI")
        specification.configured()
    paths = product_paths()
    runner_paths = [Path(__file__).resolve(), FIXTURE, ROOT / "tests/harness_continuation_probe.py", accepted.FIXTURE,
                    ROOT / "tests/harness_session_probe.py", previous.FIXTURE,
                    ROOT / "tests/harness_tool_chat_probe.py", ROOT / "tests/fixtures/harness_tool002a/cases.py",
                    ROOT / "tests/harness_tool_probe.py", ROOT / "tests/fixtures/harness_tool001/cases.py",
                    ROOT / "scripts/session-demo-001b-verify.py", ROOT / "tests/harness_model_probe.py",
                    ROOT / "tests/harness_chat_probe.py", ROOT / "tests/harness_entry_probe.py", ROOT / "tests/model_tool_probe.py",
                    ROOT / "tests/foundation_probe.py", ROOT / "tests/normal_graph_identity.py",
                    ROOT / "tests/fixtures/harness_model001/cases.py", *chat.once.previous.graph_identity.bootstrap_evidence_paths(),
                    ROOT / "config/etas-latest-main.json"]
    runner_paths += sorted(path for path in (chat.once.FIXTURE / "workspace").rglob("*") if path.is_file())
    frozen_product, frozen_runner = hashes(paths), hashes(runner_paths)
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == value or value in destination.parents for value in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("evidence must be persistent")
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="session-lifecycle-", dir=destination))
    for path in paths + runner_paths:
        retain(path, evidence / "frozen-inputs" / path.relative_to(ROOT))
    cases, prehost = specification.cases(), specification.prehost_cases()
    save(evidence / "cases.json", {"lifecycle": cases, "prehost": prehost})
    result = {"task": "CLI-002A", "status": "not_run", "prepared_only": options.prepare_only,
              "protocol_ready": specification.PROTOCOL_READY, "case_count": len(cases), "prehost_case_count": len(prehost),
              "cases": [dict(item, status="not_run") for item in cases], "commands": [],
              "scope": "native public init/new/resume/show and exact hints; provider-free dedicated help/topics/show; configured native pre-Host argument errors",
              "prehost_qualification": "Per-command help/errors use a fresh initialized owned store, normal selected profile, synthetic API key and no HTTP server; dedicated help/topics use an empty directory with all provider tables removed and no key.",
              "product_sources_and_graph": frozen_product, "runner_inputs": frozen_runner,
              "cases_sha256": digest(evidence / "cases.json"), "cli_requested": options.etas,
              "created_utc": datetime.now(timezone.utc).isoformat(), "ordinary_memory_limit_bytes": accepted.MEMORY_LIMIT}
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: construction only; no SQLite/server/Etas dispatch", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    fixture_before = snapshot(options.fixture_root)
    assert fixture_before == snapshot(chat.once.FIXTURE / "workspace")
    mount = next(line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[4] == str(options.fixture_root))
    assert "ro" in mount[5].split(",") and resources()["memory.max"] == str(accepted.MEMORY_LIMIT)
    result.update(status="running", cli_path=str(cli), cli_sha256=digest(cli), fixture_before=fixture_before, fixture_mount=mount)
    save(output, result)
    completed, failure = {}, None

    def project_for(item, directory, label, *, readonly=False):
        project = evidence / "projects" / label
        for source in paths:
            if source.name != "etas.toml":
                retain(source, project / source.relative_to(ROOT))
        (project / "etas.toml").write_text(manifest(item, directory, options.fixture_root, readonly=readonly))
        assert {str(path.relative_to(project)): digest(path) for path in (project / "src").rglob("*.es")} == {
            name: value for name, value in frozen_product.items() if name.startswith("src/")}
        return project

    def invoke(item, project, directory, label, action, expected, *, code=0, memory=(0, 0), arguments=None,
               model_phase=None, attempted=False, predecessor=None, successor_show=False, configured_key=False):
        command_dir = evidence / "commands" / (str(len(result["commands"])).zfill(3) + "-" + label)
        command_dir.mkdir(parents=True)
        trace_path = command_dir / "trace.json"
        arguments = specification.arguments(item, action, successor_show=successor_show) if arguments is None else arguments
        argv = [str(cli), "run", str(project), "--flow", specification.FLOWS[action], "--allow-effects", "--trace-out", str(trace_path)]
        if arguments:
            argv += ["--args", *arguments]
        assert "--profile" not in argv and "--bin" not in argv, "public flow/profile selection was bypassed"
        before = previous.inspect(directory)
        inputs = {str(path.relative_to(project)): digest(path) for path in project.rglob("*") if path.is_file()}
        model = specification.prior.model_case(item, model_phase, attempted) if model_phase is not None else None
        configured_key = configured_key or action in {"new", "resume"} and model is None
        profiles = tomllib.loads((project / "etas.toml").read_text())["runtime"]["profiles"]
        provider_free = all("model" not in value and "filesystem" not in value for value in profiles.values())
        command = {"label": label, "action": action, "command": argv, "cwd": str(directory), "expected_exit": code,
                   "expected_stdout": expected, "expected_memory": memory, "inputs": inputs, "status": "running",
                   "server_started": model is not None, "database_before": before, "resources_before": resources(),
                   "manifest_selected_profile": specification.PROFILES[action], "explicit_profile_override": False,
                   "synthetic_provider_key_present": configured_key or model is not None,
                   "all_model_file_provider_tables_removed": provider_free,
                   "started_utc": datetime.now(timezone.utc).isoformat()}
        result["commands"].append(command)
        for name, value in [("argv", argv), ("inputs", inputs), ("case", item)]:
            save(command_dir / (name + ".json"), value)
        (command_dir / "stdin.bin").write_bytes(b"")
        save(output, result)
        assert hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        started = time.monotonic()
        phase = model_phase or ("successor-show" if successor_show else "show" if action == "show" else action)
        prior_key = os.environ.get("NOMO_HARNESS_TOOL_TEST_KEY")
        if configured_key:
            os.environ["NOMO_HARNESS_TOOL_TEST_KEY"] = specification.TOKEN
        else:
            os.environ.pop("NOMO_HARNESS_TOOL_TEST_KEY", None)
        try:
            stdout, stderr, exit_code, timed_out, http, pid, admission = accepted.run_process(
                argv, directory, model, options.timeout, phase=phase, item=item, predecessor=predecessor)
        finally:
            if prior_key is None:
                os.environ.pop("NOMO_HARNESS_TOOL_TEST_KEY", None)
            else:
                os.environ["NOMO_HARNESS_TOOL_TEST_KEY"] = prior_key
        for name, raw in [("stdout", stdout), ("stderr", stderr)]:
            target = command_dir / (name + ".bin"); target.write_bytes(raw)
            command.update({name + "_base64": base64.b64encode(raw).decode("ascii"), name + "_sha256": digest(target),
                            name + "_retained": str(target.relative_to(evidence))})
        save(command_dir / "http-observations.json", http)
        save(command_dir / "admission-observations.json", admission)
        after = previous.inspect(directory)
        command.update(exit=exit_code, timeout=timed_out, pid=pid, actual_http_count=len(http), database_after=after,
                       resources_after=resources(), status="observed", elapsed_seconds=time.monotonic() - started,
                       http_retained=str((command_dir / "http-observations.json").relative_to(evidence)),
                       http_sha256=digest(command_dir / "http-observations.json"), admission_observations=admission,
                       admission_retained=str((command_dir / "admission-observations.json").relative_to(evidence)),
                       admission_sha256=digest(command_dir / "admission-observations.json"))
        if trace_path.is_file():
            command.update(trace_retained=str(trace_path.relative_to(evidence)), trace_sha256=digest(trace_path))
        save(output, result)
        assert not timed_out and exit_code == code and stdout == expected.encode(), "native entry exit/complete transcript differs"
        if code:
            native_abort = attempted and action == "resume" and item["second"]["kind"] == "host_abort"
            wrapper = ("Nomo session " + action + " refused; see REFUSED output").encode()
            assert stderr and (wrapper not in stderr if native_abort else b"analysis::ExecutionAborted" in stderr and wrapper in stderr)
        else:
            assert not stderr
        assert specification.TOKEN.encode() not in stdout + stderr and admission["error"] is None
        command.update(accepted.trace_observation(json.loads(trace_path.read_text()), model, http, memory, phase))
        if model is not None and attempted:
            command.update(accepted.assert_http(item, model_phase, http))
        if action == "resume" and http:
            assert len(admission["observations"]) == len(http)
        if action in {"show", "help"} or memory == (0, 0) or action == "resume" and not attempted:
            assert before == after, "read/refused public command mutated logical data"
        session_lines = [json.loads(line[len("SESSION "):]) for line in stdout.decode().splitlines() if line.startswith("SESSION [")]
        next_lines = [json.loads(line[len("NEXT "):]) for line in stdout.decode().splitlines() if line.startswith("NEXT [")]
        command.update(session_hints=session_lines, next_hints=next_lines)
        if code:
            assert all("remaining-turns" not in values and "published-first" not in values and "published-successor" not in values for values in session_lines)
            assert all(values[0] in {specification.FLOWS["show"], specification.FLOWS["help"]} for values in next_lines)
        if action == "show":
            assert not model and not http and not command["model_actions"] and not command["file_actions"] and command["memory_counts"][1] == 0
        assert hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        assert all((project / name).is_file() and digest(project / name) == value for name, value in inputs.items())
        assert snapshot(options.fixture_root) == fixture_before
        assert command["resources_after"]["memory.max"] == str(accepted.MEMORY_LIMIT) and pressure(command["resources_before"]) == pressure(command["resources_after"])
        command["status"] = "passed"; save(output, result)
        print("PASS " + label + " HTTP=" + str(len(http)) + " Memory=" + str(memory), flush=True)
        return command, http

    try:
        empty = evidence / "stores" / "prehost-provider-free"; empty.mkdir(parents=True, mode=0o700)
        ready = evidence / "stores" / "prehost-configured"; ready.mkdir(parents=True, mode=0o700)
        seed = cases[0]
        quiet = project_for(seed, empty, "prehost-provider-free", readonly=True)
        configured = project_for(seed, ready, "prehost-configured")
        invoke(seed, configured, ready, "prehost-owned-store-init", "init",
               "INITIALIZED Harness checkpoint owner " + seed["id"] + "\n" + specification.success_hints(seed, "init"), memory=(3, 1))
        for entry in prehost:
            dedicated = entry["action"] == "help"
            expected = entry.get("stdout", specification.HELP) if entry.get("help") else specification.parse_refusal(entry["action"], entry["diagnostic"])
            invoke(seed, quiet if dedicated else configured, empty if dedicated else ready, "prehost-" + entry["label"], entry["action"], expected,
                   code=0 if entry.get("help") else 3, arguments=entry["args"], configured_key=not dedicated)
            assert not (empty / "harness.sqlite3").exists(), "dedicated provider-free help created SQLite data"
        for item in result["cases"]:
            directory = evidence / "stores" / item["label"]; directory.mkdir(parents=True, mode=0o700)
            assert directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o077 == 0
            project = project_for(item, directory, item["label"])
            readonly = project_for(item, directory, item["label"] + "-show-provider-free", readonly=True)
            init, _ = invoke(item, project, directory, item["label"] + "-init", "init",
                             "INITIALIZED Harness checkpoint owner " + item["id"] + "\n" + specification.success_hints(item, "init"), memory=(3, 1))
            invoke(item, project, directory, item["label"] + "-repeat-init", "init",
                   "REFUSED checkpoint store already claimed\n" + specification.failure_hints(item, "init"), code=3, memory=(1, 0))
            if item["kind"] == "new_publication_failure":
                sql = previous.trigger_sql("published")
                with sqlite3.connect(directory / "harness.sqlite3") as connection:
                    connection.execute(sql)
                item["test_trigger"] = sql
            first_failure = item["kind"] in {"new_failure", "new_publication_failure"}
            memory = (3, 1) if item["kind"] == "new_failure" else (6, 3) if item["kind"] == "new_publication_failure" else (7, 3)
            started, first_http = invoke(item, project, directory, item["label"] + "-new", "new", specification.new_stdout(item),
                                         code=3 if first_failure else 0, memory=memory, model_phase="save", attempted=True)
            assert started["pid"] != init["pid"]
            if first_failure:
                old = accepted.old_rows(directory)
                assert old["owner"]["value"] == previous.expected_record(item, "claimed")
                pending = item["kind"] == "new_publication_failure"
                assert set(old) == ({"owner", "checkpoint:" + item["id"]} if pending else {"owner"})
                if pending:
                    assert old["checkpoint:" + item["id"]]["value"]["phase"] == "pending"
                diagnostic = "checkpoint not published; no recovery or retry" if pending else "checkpoint missing; no completed save"
                invoke(item, readonly, directory, item["label"] + "-show-failed-first", "show",
                       "REFUSED " + diagnostic + "\n" + specification.failure_hints(item, "show"), code=3, memory=(2, 0))
                invoke(item, project, directory, item["label"] + "-repeat-new", "new",
                       "REFUSED checkpoint owner or phase mismatch; no retry\n" + specification.failure_hints(item, "new"), code=3, memory=(1, 0))
                assert not accepted.new_rows(directory)
            else:
                first_body = specification.first.body(specification.low_first(item))
                old = accepted.old_rows(directory); predecessor = old["checkpoint:" + item["id"]]
                assert predecessor["value"] == previous.expected_record(item, "published", first_body)
                previous.assert_saved(specification.low_first(item), directory, first_http)
                invoke(item, readonly, directory, item["label"] + "-show-first-before", "show",
                       "CHECKPOINT " + first_body + "\n" + specification.success_hints(item, "show"), memory=(3, 0))
                if item["kind"] == "resume_publication_failure":
                    sql = accepted.trigger_sql("published")
                    with sqlite3.connect(directory / "harness.sqlite3") as connection:
                        connection.execute(sql)
                    item["test_trigger"] = sql
                failure_kind = item["kind"] in {"resume_failure", "resume_publication_failure"}
                memory = (16, 4) if item["kind"] == "resume_publication_failure" else (9, 1) if item["second"]["kind"] == "host_abort" else (11, 2) if failure_kind else (17, 4)
                resumed, http = invoke(item, project, directory, item["label"] + "-resume", "resume", specification.resume_stdout(item),
                                       code=3 if failure_kind else 0, memory=memory, model_phase="continue", attempted=True, predecessor=predecessor)
                assert resumed["pid"] != started["pid"] and accepted.old_rows(directory) == old
                if failure_kind:
                    values = accepted.new_rows(directory)
                    admitted = values["admission:" + item["id"]]["value"]
                    phase = "settled" if item["kind"] == "resume_publication_failure" else "admitted" if item["second"]["kind"] == "host_abort" else "failed"
                    assert admitted["phase"] == phase and admitted["resolved"] == (phase != "admitted")
                    assert admitted["reserved"] == accepted.ledger([7, 4, 8192, 1, 4096] if phase == "admitted" else [0] * 5)
                    pending = item["kind"] == "resume_publication_failure"
                    assert set(values) == ({"admission:" + item["id"], "successor:" + item["successor"]} if pending else {"admission:" + item["id"]})
                    if pending:
                        assert values["successor:" + item["successor"]]["value"]["phase"] == "pending"
                    diagnostic = "successor admission, publication or predecessor mismatch" if pending else "successor missing; no completed continuation"
                    invoke(item, readonly, directory, item["label"] + "-show-failed-successor", "show",
                           "REFUSED " + diagnostic + "\n" + specification.failure_hints(item, "show", successor=True),
                           code=3, memory=(5, 0), successor_show=True)
                else:
                    observed = accepted.assert_successor(item, directory, predecessor, http)
                    shown, _ = invoke(item, readonly, directory, item["label"] + "-show-successor", "show",
                                      "SUCCESSOR " + observed["body"] + "\n" + specification.success_hints(item, "show", successor=True),
                                      memory=(10, 0), successor_show=True)
                    assert shown["pid"] != resumed["pid"]
                    completed[item["label"]] = dict(observed, contexts=resumed["contexts"], directory=str(directory))
                invoke(item, readonly, directory, item["label"] + "-show-first-after", "show",
                       "CHECKPOINT " + first_body + "\n" + specification.success_hints(item, "show"), memory=(3, 0))
                invoke(item, project, directory, item["label"] + "-repeat-resume", "resume",
                       "REFUSED " + specification.prior.DUPLICATE_DIAGNOSTIC + "\n" + specification.failure_hints(item, "resume"), code=3, memory=(4, 0))
                if item["label"] == "lifecycle-prior-alpha-no-replay":
                    invoke(item, project, directory, item["label"] + "-third-turn", "resume",
                           "REFUSED checkpoint owner or phase mismatch; no retry\n" + specification.failure_hints(dict(item, id=item["successor"], successor="forbidden-third"), "resume"),
                           code=3, memory=(1, 0), arguments=specification.arguments(item, "resume", id=item["successor"], successor="forbidden-third"))
                assert accepted.old_rows(directory) == old
            item["status"] = "passed"; save(output, result)
        alpha, beta = completed["lifecycle-prior-alpha-no-replay"], completed["lifecycle-prior-beta-no-replay"]
        assert alpha["contexts"][0]["request"] == beta["contexts"][0]["request"] and alpha["contexts"][0]["allowed"] == beta["contexts"][0]["allowed"]
        for field in ["result", "outcome", "answer"]:
            assert alpha["contexts"][0]["prior"][field] != beta["contexts"][0]["prior"][field]
        assert alpha["fields"][8] != beta["fields"][8] and alpha["fields"][12] != beta["fields"][12]
        assert {tuple(value["usage"]) for value in completed.values()} >= {(10, 6, 12288, 0, 0), (12, 7, 14336, 1, 4096), (14, 8, 16384, 2, 8192)}
        assert len(result["commands"]) == len({command["pid"] for command in result["commands"]}) == 118
        assert len(completed) == 7
        result.update(native_automatic_profiles_proved=True, provider_free_dedicated_help_and_show_proved=True,
                      configured_prehost_argument_errors_proved=True,
                      cross_process_prior_dependence_proved=True, prior_tool_not_replayed=True, predecessor_preserved=True)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "item" in locals():
            item.update(status="failed", failure=failure)
        if result["commands"] and result["commands"][-1]["status"] != "passed":
            result["commands"][-1].update(status="failed", failure=failure)
    finally:
        unchanged = hashes(paths) == frozen_product and hashes(runner_paths) == frozen_runner
        result.update(status="passed" if not failure and all(value["status"] == "passed" for value in result["cases"]) and unchanged else "failed",
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
