#!/usr/bin/env python3
"""HARNESS-001B real ordinary entry tests and retained full-root evidence.

No Etas entry replacement or Python product mock is used. Every executable case
runs the current complete product ROOT with the ordinary foundation profile.
The serial owner must first pass its one whole-root 4-GiB static preflight.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/harness001b/cases.py"
MEMORY_LIMIT = 4294967296


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n")


def retain(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    before = digest(source)
    shutil.copyfile(source, target)
    if digest(source) != before or digest(target) != before:
        raise RuntimeError("retained input changed during copy")
    return {"sha256": before, "bytes": target.stat().st_size}


def resources():
    value = {"kind": "cgroup-v2", "observed_utc": datetime.now(timezone.utc).isoformat()}
    for name in ["memory.max", "memory.current", "memory.peak", "memory.events", "pids.max", "cpu.max"]:
        path = Path("/sys/fs/cgroup") / name
        value[name] = path.read_text().strip() if path.is_file() else None
    return value


def pressure(value):
    return {key: int(count) for key, count in
            (line.split() for line in (value["memory.events"] or "").splitlines())
            if key in {"max", "oom", "oom_kill", "oom_group_kill"}}


def load_cases():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("harness001b_cases", FIXTURE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    values = module.cases()
    labels = [value["label"] for value in values]
    if not 0 < len(values) <= 128 or len(labels) != len(set(labels)):
        raise ValueError("entry fixtures must be bounded with unique labels")
    for value in values:
        if value["mode"] not in {"harness", "default"} or any("\x00" in item for item in value["args"]):
            raise ValueError("only real default/harness OS argv fixtures are permitted")
    return values


def product_paths():
    paths = sorted((ROOT / "src").rglob("*.es"))
    if len(paths) != 34 or any(path.name.startswith("model_session") for path in paths):
        raise ValueError("expected isolated 34-file whole product, not the pending shared root")
    return paths + [ROOT / "etas.toml", ROOT / "etas.lock"]


def input_hashes(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def run_process(command, stdin, timeout):
    process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(stdin, timeout=timeout)
        return stdout, stderr, process.returncode, False
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        return stdout, stderr, process.returncode, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--etas", required=True, help="explicit absolute unchanged normal Etas CLI")
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--prepare-only", action="store_true")
    options = parser.parse_args()
    if not 1 <= options.timeout <= 600:
        parser.error("timeout must be within 1..600 seconds")
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == path or path in destination.parents for path in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("evidence must be persistent, not under /tmp or /private/tmp")
    if not Path(options.etas).is_absolute():
        parser.error("an absolute normal Etas executable is required")
    cases, paths = load_cases(), product_paths()
    runner_paths = [Path(__file__).resolve(), FIXTURE, ROOT / "tests/foundation_probe.py",
                    ROOT / "tests/normal_graph_identity.py", ROOT / "scripts/etas-0013-cli-bootstrap.py"]
    frozen_product = input_hashes(paths)
    frozen_runner = input_hashes(runner_paths)
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness001b-entry-", dir=destination))
    for source in paths + runner_paths:
        retain(source, evidence / "frozen-inputs" / source.relative_to(ROOT))
    save(evidence / "cases.json", cases)
    result = {
        "task": "HARNESS-001B", "scope": "actual normal opt-in entry and affected default entry; no durable/live/concurrent acceptance",
        "created_utc": datetime.now(timezone.utc).isoformat(), "product_root": str(ROOT),
        "status": "not_run", "prepared_only": options.prepare_only, "case_count": len(cases),
        "case_modes": {mode: sum(item["mode"] == mode for item in cases) for mode in ["harness", "default"]},
        "product_sources_and_graph": frozen_product, "runner_inputs": frozen_runner,
        "cases_sha256": digest(evidence / "cases.json"), "ordinary_memory_limit_bytes": MEMORY_LIMIT,
        "cli_requested": options.etas, "cli_path": None, "cli_sha256": None,
        "commands": [dict(item, status="not_run") for item in cases],
    }
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: exact input/transcript construction retained; no Etas commands dispatched", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    result["initial_resources"] = resources()
    if not cli.is_file() or not os.access(cli, os.X_OK) or result["initial_resources"]["memory.max"] != str(MEMORY_LIMIT):
        result.update(status="pending_execution_environment",
                      limitation="available absolute normal CLI and measured exactly ordinary 4-GiB cgroup required; no Etas command dispatched")
        save(output, result)
        return 2
    result["cli_path"], result["cli_sha256"] = str(cli), digest(cli)
    result["status"] = "running"
    save(output, result)
    failure = None
    try:
        for ordinal, command in enumerate(result["commands"]):
            directory = evidence / "commands" / (str(ordinal).zfill(3) + "-" + command["label"])
            directory.mkdir(parents=True)
            command["inputs"] = {}
            for source in paths + runner_paths:
                relative = source.relative_to(ROOT)
                target = directory / "inputs" / relative
                command["inputs"][str(relative)] = dict(retain(source, target), retained=str(target.relative_to(evidence)))
            stdin = command["stdin"].encode("utf-8")
            (directory / "stdin.bin").write_bytes(stdin)
            save(directory / "case.json", cases[ordinal])
            before = resources()
            assert before["memory.max"] == str(MEMORY_LIMIT), "ordinary resource ceiling changed"
            assert input_hashes(product_paths()) == frozen_product, "protected complete product changed"
            assert input_hashes(runner_paths) == frozen_runner, "protected runner inputs changed"
            assert digest(cli) == result["cli_sha256"], "normal CLI binary changed"
            argv = [str(cli), "run", str(ROOT)]
            if command["mode"] == "harness":
                argv += ["--flow", "harness"]
            argv += ["--profile", "foundation", "--allow-effects"]
            if command["args"]:
                argv += ["--args", *command["args"]]
            save(directory / "argv.json", argv)
            command.update(command=argv, resources_before=before, started_utc=datetime.now(timezone.utc).isoformat(),
                           stdin_sha256=digest(directory / "stdin.bin"), stdin_retained=str((directory / "stdin.bin").relative_to(evidence)),
                           case_sha256=digest(directory / "case.json"), case_retained=str((directory / "case.json").relative_to(evidence)),
                           argv_sha256=digest(directory / "argv.json"), argv_retained=str((directory / "argv.json").relative_to(evidence)), status="running")
            save(output, result)
            started = time.monotonic()
            stdout, stderr, code, timed_out = run_process(argv, stdin, options.timeout)
            (directory / "stdout.bin").write_bytes(stdout)
            (directory / "stderr.bin").write_bytes(stderr)
            after = resources()
            command.update(exit=code, timeout=timed_out, elapsed_seconds=time.monotonic() - started,
                           finished_utc=datetime.now(timezone.utc).isoformat(), resources_after=after,
                           stdout_base64=base64.b64encode(stdout).decode("ascii"), stderr_base64=base64.b64encode(stderr).decode("ascii"),
                           stdout_sha256=digest(directory / "stdout.bin"), stderr_sha256=digest(directory / "stderr.bin"),
                           stdout_retained=str((directory / "stdout.bin").relative_to(evidence)),
                           stderr_retained=str((directory / "stderr.bin").relative_to(evidence)), status="observed")
            save(output, result)
            assert not timed_out, "actual entry command timed out; no unchanged retry"
            assert code == command["expected_exit"], "actual CLI process exit differs from expected refusal/success"
            assert stdout == command["expected_stdout"].encode("utf-8"), "actual entry transcript differs from exact expected observation"
            if command["expected_exit"]:
                assert b"analysis::ExecutionAborted" in stderr and command["expected_abort"].encode() in stderr, "refusal did not reach genuine failing wrapper"
            else:
                assert stderr == b"", "successful entry wrote unexpected stderr"
            if command["mode"] == "harness":
                if command["admitted"]:
                    assert stdout.count(b"EVENT ") == 3 and b"REFUSED " not in stdout, "admitted path must exchange exactly three ordered events"
                    assert stdout.endswith(("LEDGER maximum=5 spent=" + str(command["expected_spent"]) + " reserved=0\n").encode()), "shared ledger not settled exactly"
                else:
                    assert all(marker not in stdout for marker in [b"EVENT ", b"FINAL ", b"LEDGER "]), "help/admission refusal unexpectedly delegated or spent child budget"
            assert after["memory.max"] == str(MEMORY_LIMIT) and pressure(before) == pressure(after), "ordinary memory ceiling/OOM events changed"
            assert input_hashes(product_paths()) == frozen_product, "protected complete product changed"
            assert input_hashes(runner_paths) == frozen_runner, "protected runner inputs changed"
            command["status"] = "passed"
            save(output, result)
            print("PASS " + command["label"], flush=True)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "command" in locals():
            command["status"] = "failed"
    finally:
        unchanged_product = input_hashes(product_paths()) == frozen_product
        unchanged_runner = input_hashes(runner_paths) == frozen_runner
        unchanged_cli = cli.is_file() and digest(cli) == result["cli_sha256"]
        complete = all(command["status"] == "passed" for command in result["commands"])
        result.update(status="passed" if complete and not failure and unchanged_product and unchanged_runner and unchanged_cli else "failed",
                      product_inputs_unchanged=unchanged_product, runner_inputs_unchanged=unchanged_runner,
                      cli_unchanged=unchanged_cli, final_resources=resources(), finished_utc=datetime.now(timezone.utc).isoformat())
        if failure:
            result["failure"] = failure
        save(output, result)
    if result["status"] != "passed":
        print("FAILED " + result.get("failure", "protected inputs changed"), flush=True)
        return 1
    print("PASS actual HARNESS-001B " + str(len(cases)) + " whole-root entry observations", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
