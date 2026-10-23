#!/usr/bin/env python3
"""HARNESS-001A actual Etas main -> child -> main fixture and evidence runner.

Python constructs typed synthetic inputs/expected observations only. Product
admission, decisions, fake tool calls, result validation and settlement execute
in the real Etas modules. The caller owns approved normal CLI/graph availability;
this script neither provisions dependencies nor changes image/VM settings.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests/fixtures/harness001a"
MEMORY_LIMIT = 4294967296
MANIFEST = '''[package]
name = "nomo-harness001a-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "nomo-harness001a-fixture"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.main"
flow = "main"
profile = "fixture"
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n")


def source_closure():
    """Retain real transitive product modules; never policy replacements."""
    pending, found = ["harness", "harness_child", "harness_contract"], {}
    while pending:
        module = pending.pop()
        if module in found:
            continue
        if module.startswith("model_session"):
            raise ValueError("pending model_session modules are outside HARNESS-001A")
        source = ROOT / "src/nomo" / (module + ".es")
        body = source.read_text()
        found[module] = source
        pending.extend(re.findall(r"^\s*import\s+nomo\.([A-Za-z_]\w*)[.\s;]", body, re.M))
    return found


def load_cases():
    sys.dont_write_bytecode = True
    specification = importlib.util.spec_from_file_location("harness001a_cases", FIXTURES / "cases.py")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    values = module.cases()
    labels = [value["label"] for value in values]
    if not 0 < len(values) <= 512 or len(labels) != len(set(labels)):
        raise ValueError("fixture labels/count must be unique and bounded")
    return values


def resources():
    observation = {"kind": "cgroup-v2", "observed_utc": datetime.now(timezone.utc).isoformat()}
    for name in ["memory.max", "memory.current", "memory.peak", "memory.events", "pids.max", "cpu.max"]:
        path = Path("/sys/fs/cgroup") / name
        observation[name] = path.read_text().strip() if path.is_file() else None
    return observation


def retain(path, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    before = digest(path)
    shutil.copyfile(path, destination)
    if digest(path) != before or digest(destination) != before:
        raise RuntimeError("input source changed while retaining evidence")
    return before


def pressure_events(observation):
    return {key: int(value) for key, value in
            (line.split() for line in (observation["memory.events"] or "").splitlines())
            if key in {"max", "oom", "oom_kill", "oom_group_kill"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True,
                        help="persistent ignored docs/agent/evidence/harness-001a directory")
    parser.add_argument("--etas", default=os.environ.get("ETAS", "etas"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=240)
    options = parser.parse_args()
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == root or root in destination.parents
           for root in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("accepted evidence requires a persistent location, not /tmp or /private/tmp")
    if options.timeout < 1 or options.timeout > 600:
        parser.error("timeout must be within 1..600 seconds")
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness001a-", dir=destination))
    project = evidence / "project"
    (project / "src/app").mkdir(parents=True)
    (project / "src/nomo").mkdir()
    sources = source_closure()
    protected = {str(path): digest(path) for path in sources.values()}
    for name, source in sources.items():
        retain(source, project / "src/nomo" / (name + ".es"))
    retain(FIXTURES / "main.es", project / "src/app/main.es")
    (project / "etas.toml").write_text(MANIFEST)
    fixtures = load_cases()
    stdin = (json.dumps(fixtures, ensure_ascii=True) + "\n").encode("ascii")
    (project / "stdin.json").write_bytes(stdin)
    project_inputs = {str(path.relative_to(project)): digest(path) for path in
                      sorted((project / "src").rglob("*.es")) + [project / "etas.toml", project / "stdin.json"]}
    runner_inputs = {}
    for path in [Path(__file__), FIXTURES / "cases.py", FIXTURES / "main.es"]:
        runner_inputs[path.name] = retain(path, evidence / "runner-inputs" / path.name)
        protected[str(path)] = runner_inputs[path.name]
    graph_inputs = {}
    for name in ["etas.toml", "etas.lock", "tests/normal_graph_identity.py", "scripts/etas-0013-cli-bootstrap.py"]:
        path = ROOT / name
        graph_inputs[name] = retain(path, evidence / "normal-graph-inputs" / name)
        protected[str(path)] = graph_inputs[name]
    commands = [
        {"name": "check-all", "args": ["check", "--all", str(project)]},
        {"name": "check-phase1", "args": ["check", "--phase1", str(project)]},
        {"name": "coordinator-pure-effects", "args": ["effects", str(project), "--flow", "coordinator_pure"]},
        {"name": "child-pure-effects", "args": ["effects", str(project), "--flow", "child_pure"]},
        {"name": "fixture-console-effects", "args": ["effects", str(project), "--flow", "main"]},
        {"name": "actual-harness-runtime", "args": ["run", str(project), "--allow-effects"]},
    ]
    result = {
        "task": "HARNESS-001A", "scope": "one serial pure Etas child; no entry/session/live/concurrent acceptance",
        "created_utc": datetime.now(timezone.utc).isoformat(), "status": "not_run",
        "prepared_only": options.prepare_only, "fixture_count": len(fixtures),
        "case_labels": [item["label"] for item in fixtures],
        "case_modes": {mode: sum(item["mode"] == mode for item in fixtures) for mode in sorted({item["mode"] for item in fixtures})},
        "product_sources": {"src/nomo/" + name + ".es": digest(path) for name, path in sources.items()},
        "runner_inputs": runner_inputs, "normal_graph_inputs": graph_inputs,
        "stdin_sha256": digest(project / "stdin.json"), "fixture_manifest_sha256": digest(project / "etas.toml"),
        "prepared_project_inputs": project_inputs,
        "cli_requested": options.etas, "cli_path": None, "cli_sha256": None,
        "ordinary_memory_limit_bytes": MEMORY_LIMIT,
        "commands": [dict(command, status="not_run") for command in commands],
        "protected_inputs_unchanged": True,
    }
    output = evidence / "results.json"
    save_json(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: retained fixture construction only; no Etas check/effects/runtime dispatched", flush=True)
        return 0
    resolved_cli = shutil.which(options.etas)
    if not Path(options.etas).is_absolute() or resolved_cli is None:
        result.update(status="pending_execution_environment",
                      limitation="an explicit available absolute normal Etas executable is required; no commands dispatched")
        save_json(output, result)
        return 2
    cli = Path(resolved_cli).resolve()
    result["cli_path"], result["cli_sha256"] = str(cli), digest(cli)
    result["initial_resources"] = resources()
    if result["initial_resources"]["memory.max"] != str(MEMORY_LIMIT):
        result.update(status="pending_execution_environment",
                      limitation="actual cgroup memory.max is not ordinary exactly 4 GiB; no commands dispatched")
        save_json(output, result)
        return 2
    result["status"] = "running"
    save_json(output, result)
    failure = None
    try:
        for ordinal, command in enumerate(result["commands"]):
            directory = evidence / "commands" / (str(ordinal).zfill(2) + "-" + command["name"])
            retained = directory / "inputs"
            retained.mkdir(parents=True)
            inputs = {}
            paths = sorted((project / "src").rglob("*.es")) + [project / "etas.toml", project / "stdin.json"]
            if (project / "etas.lock").exists():
                paths.append(project / "etas.lock")
            for path in paths:
                relative = path.relative_to(project)
                target = retained / relative
                inputs[str(relative)] = {"sha256": retain(path, target), "retained": str(target.relative_to(evidence))}
            before = resources()
            assert before["memory.max"] == str(MEMORY_LIMIT), "ordinary resource ceiling changed"
            assert all((project / name).exists() and digest(project / name) == value for name, value in project_inputs.items()), "prepared project input changed"
            assert all(Path(name).exists() and digest(Path(name)) == value for name, value in protected.items()), "protected input changed"
            assert digest(cli) == result["cli_sha256"], "normal CLI binary changed"
            command.update(command=[str(cli), *command["args"]], inputs=inputs,
                           resources_before=before, started_utc=datetime.now(timezone.utc).isoformat(), status="running")
            save_json(output, result)
            started = time.monotonic()
            try:
                process = subprocess.run(command["command"], cwd=project,
                                         input=stdin if command["name"] == "actual-harness-runtime" else None,
                                         capture_output=True, timeout=options.timeout)
                stdout, stderr, exit_code = process.stdout, process.stderr, process.returncode
            except subprocess.TimeoutExpired as error:
                stdout, stderr, exit_code = error.stdout or b"", error.stderr or b"", None
                command["timeout"] = True
            (directory / "stdout.bin").write_bytes(stdout)
            (directory / "stderr.bin").write_bytes(stderr)
            command.update(elapsed_seconds=time.monotonic() - started, exit=exit_code,
                           resources_after=resources(), finished_utc=datetime.now(timezone.utc).isoformat(),
                           stdout_base64=base64.b64encode(stdout).decode("ascii"),
                           stderr_base64=base64.b64encode(stderr).decode("ascii"),
                           stdout_retained=str((directory / "stdout.bin").relative_to(evidence)),
                           stderr_retained=str((directory / "stderr.bin").relative_to(evidence)), status="observed")
            save_json(output, result)
            if command["name"] == "check-phase1":
                supports = re.findall(rb"warning\[effect::RuntimeRequiredInPhase1\]: checked HIR execution requires host support: \{([^}]+)\}", stderr)
                assert exit_code == 1 and supports and all(value == b"Console" for value in supports), "phase1 must refuse only fixture Console support"
                assert b"error[" not in stderr, "phase1 has a compile software bug beyond expected fixture Console refusal"
            else:
                assert exit_code == 0, "Etas command did not succeed"
            if command["name"].endswith("-pure-effects"):
                requested = re.findall(rb"^\s*requested actions: (.+)$", stdout, re.M)
                defaults = re.findall(rb"^\s*default actions: (.+)$", stdout, re.M)
                assert requested == [b"[]"], "pure product function requested Host actions"
                assert defaults == [b"[]"], "pure product function has unexpected default Host actions"
            if command["name"] == "fixture-console-effects":
                requested = re.findall(rb"^\s*requested actions: \[([^\]]*)\]$", stdout, re.M)
                assert len(requested) == 1, "fixture needs one effect report"
                actions = {item for item in requested[0].split(b", ") if item}
                assert actions == {b"Console.stdin_read_all", b"Console.stdout_write"}, "fixture has non-Console authority"
            if command["name"] == "actual-harness-runtime":
                expected = []
                for index, item in enumerate(fixtures):
                    expected += ["CASE " + str(index) + " " + item["label"], "PASS " + str(index) + " " + item["label"]]
                expected.append("PASS HARNESS001A " + str(len(fixtures)))
                assert stdout.decode("utf-8").splitlines() == expected and stderr == b"", "runtime did not pass every focused fixture"
            assert command["resources_after"]["memory.max"] == str(MEMORY_LIMIT), "ordinary resource ceiling changed"
            assert pressure_events(command["resources_after"]) == pressure_events(before), "ordinary memory ceiling/OOM event increased"
            assert all((project / name).exists() and digest(project / name) == value for name, value in project_inputs.items()), "prepared project input changed"
            command["status"] = "passed"
            save_json(output, result)
            print("PASS " + command["name"], flush=True)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "command" in locals():
            command["status"] = "failed"
    finally:
        unchanged = all(Path(name).exists() and digest(Path(name)) == value for name, value in protected.items())
        binary_unchanged = cli.exists() and digest(cli) == result["cli_sha256"]
        result["protected_inputs_unchanged"], result["cli_unchanged"] = unchanged, binary_unchanged
        result["prepared_project_inputs_unchanged"] = all(
            (project / name).exists() and digest(project / name) == value for name, value in project_inputs.items())
        result["final_resources"] = resources()
        complete = all(item["status"] == "passed" for item in result["commands"])
        result["status"] = "passed" if complete and not failure and unchanged and binary_unchanged and result["prepared_project_inputs_unchanged"] else "failed"
        if failure:
            result["failure"] = failure
        result["finished_utc"] = datetime.now(timezone.utc).isoformat()
        save_json(output, result)
    if result["status"] != "passed":
        print("FAILED " + result.get("failure", "input or CLI identity changed"), flush=True)
        return 1
    print("PASS actual Etas HARNESS-001A " + str(len(fixtures)) + " fixtures; serial pure component only", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
