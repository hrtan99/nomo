#!/usr/bin/env python3
"""CLI-001A actual-Etas component fixture runner; Python supplies no parser policy.

Use --prepare-only to retain a not-run fixture without any CLI availability probe.
The caller owns approved execution/graph provenance and ordinary resource limits.
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
FIXTURES = ROOT / "tests/fixtures/cli001a"
MANIFEST = '''[package]
name = "nomo-cli001a-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "nomo-cli001a-fixture"
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
    """Copy real transitive Nomo modules, never replacement policy/test stubs."""
    pending, found = ["cli_request"], {}
    while pending:
        module = pending.pop()
        if module in found:
            continue
        if module.startswith("model_session"):
            raise ValueError("pending model_session modules are outside CLI-001A")
        source = ROOT / "src/nomo" / (module + ".es")
        body = source.read_text()
        found[module] = source
        pending.extend(re.findall(r"^\s*import\s+nomo\.([A-Za-z_]\w*)[.\s;]", body, re.M))
    return found


def load_cases():
    sys.dont_write_bytecode = True
    specification = importlib.util.spec_from_file_location("cli001a_cases", FIXTURES / "cases.py")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    values = module.cases()
    labels = [value["label"] for value in values]
    if not 0 < len(values) <= 512 or len(labels) != len(set(labels)):
        raise ValueError("fixture labels/count must be unique and bounded")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True,
                        help="persistent ignored output directory; not /tmp")
    parser.add_argument("--etas", default=os.environ.get("ETAS", "etas"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=240)
    options = parser.parse_args()
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == root or root in destination.parents
           for root in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("accepted evidence requires a persistent location, not /tmp or /private/tmp")
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="cli001a-", dir=destination))
    project = evidence / "project"
    (project / "src/app").mkdir(parents=True)
    (project / "src/nomo").mkdir()
    sources = source_closure()
    protected = {str(path): digest(path) for path in sources.values()}
    for name, source in sources.items():
        target = project / "src/nomo" / (name + ".es")
        shutil.copyfile(source, target)
        assert digest(source) == protected[str(source)], "product source changed while copying"
        assert digest(target) == protected[str(source)], "copied product source differs from frozen input"
    shutil.copyfile(FIXTURES / "main.es", project / "src/app/main.es")
    (project / "etas.toml").write_text(MANIFEST)
    fixtures = load_cases()
    stdin = (json.dumps(fixtures, ensure_ascii=True) + "\n").encode("ascii")
    (project / "stdin.json").write_bytes(stdin)
    (evidence / "runner-inputs").mkdir()
    for path in [Path(__file__), FIXTURES / "cases.py", FIXTURES / "main.es"]:
        shutil.copyfile(path, evidence / "runner-inputs" / path.name)
    commands = [
        {"name": "check-all", "args": ["check", "--all", str(project)]},
        {"name": "check-phase1", "args": ["check", "--phase1", str(project)]},
        {"name": "args-pure-effects", "args": ["effects", str(project), "--flow", "args_pure"]},
        {"name": "line-pure-effects", "args": ["effects", str(project), "--flow", "line_pure"]},
        {"name": "actual-parser-runtime", "args": ["run", str(project), "--allow-effects"]},
    ]
    result = {
        "task": "CLI-001A", "scope": "pure request/line component only; not entry/resume acceptance",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "status": "not_run", "prepared_only": options.prepare_only,
        "fixture_count": len(fixtures), "case_labels": [item["label"] for item in fixtures],
        "product_sources": {"src/nomo/" + name + ".es": digest(path) for name, path in sources.items()},
        "runner_inputs": {path.name: digest(path) for path in (evidence / "runner-inputs").iterdir()},
        "stdin_sha256": digest(project / "stdin.json"),
        "cli_requested": options.etas, "cli_path": None, "cli_sha256": None,
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
    if resolved_cli is None:
        result["status"] = "pending_execution_environment"
        result["limitation"] = "requested installed Etas executable is unavailable; no commands dispatched"
        save_json(output, result)
        return 2
    cli = Path(resolved_cli).resolve()
    result["cli_path"], result["cli_sha256"] = str(cli), digest(cli)
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
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
                inputs[str(relative)] = {"sha256": digest(target), "retained": str(target.relative_to(evidence))}
            command.update(command=[str(cli), *command["args"]], inputs=inputs,
                           started_utc=datetime.now(timezone.utc).isoformat(), status="running")
            save_json(output, result)
            started = time.monotonic()
            try:
                process = subprocess.run(command["command"], cwd=project,
                                         input=stdin if command["name"] == "actual-parser-runtime" else None,
                                         capture_output=True, timeout=options.timeout)
                stdout, stderr, exit_code = process.stdout, process.stderr, process.returncode
            except subprocess.TimeoutExpired as error:
                stdout, stderr, exit_code = error.stdout or b"", error.stderr or b"", None
                command["timeout"] = True
            (directory / "stdout.bin").write_bytes(stdout)
            (directory / "stderr.bin").write_bytes(stderr)
            command.update(elapsed_seconds=time.monotonic() - started, exit=exit_code,
                           stdout_base64=base64.b64encode(stdout).decode("ascii"),
                           stderr_base64=base64.b64encode(stderr).decode("ascii"),
                           stdout_retained=str((directory / "stdout.bin").relative_to(evidence)),
                           stderr_retained=str((directory / "stderr.bin").relative_to(evidence)),
                           status="observed")
            save_json(output, result)
            if command["name"] == "check-phase1":
                supports = re.findall(rb"warning\[effect::RuntimeRequiredInPhase1\]: checked HIR execution requires host support: \{([^}]+)\}", stderr)
                assert exit_code == 1 and supports and all(value == b"Console" for value in supports), "phase1 must refuse only fixture Console support"
                assert b"error[" not in stderr, "phase1 has a compile software bug beyond expected Console refusal"
            else:
                assert exit_code == 0, "Etas command did not succeed"
            if command["name"].endswith("-effects"):
                requested = re.findall(rb"^\s*requested actions: (.+)$", stdout, re.M)
                assert requested == [b"[]"], "pure parser requested Host actions"
                defaults = re.findall(rb"^\s*default actions: (.+)$", stdout, re.M)
                assert not defaults or defaults == [b"[]"], "pure parser has default Host actions"
            if command["name"] == "actual-parser-runtime":
                observed = stdout.decode("utf-8").splitlines()
                expected = []
                for index, item in enumerate(fixtures):
                    expected += ["CASE " + str(index) + " " + item["label"],
                                 "PASS " + str(index) + " " + item["label"]]
                expected.append("PASS CLI001A " + str(len(fixtures)))
                assert observed == expected and stderr == b"", "runtime did not pass every original focused fixture"
            command["status"] = "passed"
            save_json(output, result)
            print("PASS " + command["name"], flush=True)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "command" in locals():
            command["status"] = "failed"
    finally:
        unchanged = all(path.exists() and digest(path) == before for path, before in
                        [(Path(name), value) for name, value in protected.items()])
        binary_unchanged = cli.exists() and digest(cli) == result["cli_sha256"]
        result["protected_inputs_unchanged"] = unchanged
        result["cli_unchanged"] = binary_unchanged
        complete = all(item["status"] == "passed" for item in result["commands"])
        result["status"] = "passed" if complete and not failure and unchanged and binary_unchanged else "failed"
        if failure:
            result["failure"] = failure
        result["finished_utc"] = datetime.now(timezone.utc).isoformat()
        save_json(output, result)
    if result["status"] != "passed":
        print("FAILED " + result.get("failure", "input or CLI identity changed"), flush=True)
        return 1
    print("PASS actual Etas CLI-001A " + str(len(fixtures)) + " fixtures; pure component only", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
