#!/usr/bin/env python3
"""Actual HARNESS-002A complete-root pipe/PTY tests plus unchanged B cases.

This harness constructs observations and retains evidence, not product behavior.
The serial owner runs its approved static helper before these ordinary 4-GiB
commands. No image, dependency, VM or accepted fixture is changed here.
"""
import argparse
from datetime import datetime, timezone
import base64
import errno
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/harness002a/cases.py"
OLD_FIXTURE = ROOT / "tests/fixtures/harness001b/cases.py"
MEMORY_LIMIT = 4294967296


def load_module(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Reuse unchanged evidence primitives, never the old 34-file guard or its entry.
previous = load_module("harness001b_evidence_helpers", ROOT / "tests/harness_entry_probe.py")
digest, save, retain = previous.digest, previous.save, previous.retain
resources, pressure = previous.resources, previous.pressure


def load_cases():
    chat = load_module("harness002a_exact_cases", FIXTURE).cases()
    prior = load_module("harness001b_exact_cases", OLD_FIXTURE).cases()
    values = chat + [dict(item, suite="HARNESS-001B-composition", transport="pipe") for item in prior]
    labels = [item["label"] for item in values]
    if not 0 < len(values) <= 160 or len(labels) != len(set(labels)):
        raise ValueError("bounded unique chat/composition fixtures required")
    if len(prior) != 62 or not any(item["transport"] == "pty" for item in chat):
        raise ValueError("all accepted B62 and genuine new PTY coverage are required")
    for item in values:
        if item["mode"] not in {"harness_chat", "harness", "default"} or any("\0" in text for text in item["args"]):
            raise ValueError("invalid real OS argv fixture")
        if item["transport"] == "pty" and "".join(step["send"] for step in item["pty_steps"]) != item["stdin"]:
            raise ValueError("PTY raw traffic must equal retained stdin")
    return values


def product_paths():
    paths = sorted((ROOT / "src").rglob("*.es"))
    if len(paths) != 35 or any(path.name.startswith("model_session") for path in paths):
        raise ValueError("expected isolated actual 35-file product, never pending shared root")
    return paths + [ROOT / "etas.toml", ROOT / "etas.lock"]


def input_hashes(paths):
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def run_pipe(argv, stdin, timeout):
    stdout, stderr, code, timed_out = previous.run_process(argv, stdin, timeout)
    return stdout, stderr, code, timed_out, None, None


def run_pty(argv, item, timeout):
    """Drive real terminal input/output; stderr remains an independent pipe."""
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    original = {"iflag": settings[0], "oflag": settings[1], "lflag": settings[3]}
    settings[3] |= termios.ICANON
    settings[3] &= ~(termios.ECHO | termios.ECHONL)
    settings[1] &= ~termios.ONLCR
    settings[6][termios.VEOF] = b"\x04"
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    applied = termios.tcgetattr(slave)
    proof = {"transport": "real-openpty", "stdin_stdout_same_slave": True,
             "master_isatty": os.isatty(master), "slave_isatty": os.isatty(slave),
             "terminal": os.ttyname(slave), "original_flags": original,
             "applied_flags": {"iflag": applied[0], "oflag": applied[1], "lflag": applied[3]},
             "canonical": bool(applied[3] & termios.ICANON),
             "echo": bool(applied[3] & termios.ECHO), "echo_newline": bool(applied[3] & termios.ECHONL),
             "onlcr": bool(applied[1] & termios.ONLCR), "veof_hex": bytes(applied[6][termios.VEOF]).hex(),
             "handshake": "exact banner, then each exact response; no blind input delay", "writes": []}
    process = subprocess.Popen(argv, cwd=ROOT, stdin=slave, stdout=slave,
                               stderr=subprocess.PIPE, start_new_session=True)
    proof["child_pid"] = process.pid
    proof["stderr_pipe_isatty"] = os.isatty(process.stderr.fileno())
    os.close(slave)
    stdout, stderr = bytearray(), bytearray()
    active = {master: stdout, process.stderr.fileno(): stderr}
    deadline, timed_out, failure = time.monotonic() + timeout, False, None

    def receive():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("PTY transcript deadline exceeded")
        ready, _, _ = select.select(list(active), [], [], remaining)
        if not ready:
            raise TimeoutError("PTY response did not arrive")
        for descriptor in ready:
            try:
                data = os.read(descriptor, 65536)
            except OSError as error:
                if descriptor == master and error.errno == errno.EIO:
                    data = b""
                else:
                    raise
            if data:
                active[descriptor].extend(data)
            else:
                del active[descriptor]

    def expect(prefix):
        while len(stdout) < len(prefix):
            if master not in active:
                raise AssertionError("PTY stdout closed before expected response")
            receive()
        if bytes(stdout) != prefix:
            raise AssertionError("PTY exact response handshake differed")

    try:
        banner = load_module("harness002a_pty_banner", FIXTURE).BANNER.encode()
        expect(banner)
        proc_fds = Path("/proc/" + str(process.pid) + "/fd")
        proof["proc_child_descriptors_observed"] = proc_fds.is_dir()
        proof["child_descriptors"] = {}
        if proof["proc_child_descriptors_observed"]:
            for number in [0, 1, 2]:
                path = str(proc_fds / str(number))
                descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY)
                try:
                    proof["child_descriptors"][str(number)] = {"target": os.readlink(path), "isatty": os.isatty(descriptor)}
                finally:
                    os.close(descriptor)
            assert proof["child_descriptors"]["0"]["isatty"] and proof["child_descriptors"]["1"]["isatty"], "child input/output are not actual TTY descriptors"
            assert not proof["child_descriptors"]["2"]["isatty"], "stderr unexpectedly shares terminal"
        else:
            # Host-only transport qualification may run on macOS without /proc.
            # Real product commands below require measured Linux cgroups and the
            # observed child descriptors; this is not substitute product proof.
            proof["descriptor_limitation"] = "host has no /proc child descriptors; only parent slave/pipe observations available"
        expected, line_boundary = banner, True
        for step in item["pty_steps"]:
            sent = step["send"].encode("utf-8")
            if step.get("eof_at_line_boundary"):
                assert line_boundary and sent == b"\x04", "terminal EOF must be sent at an empty line boundary"
            proof["writes"].append({"bytes_hex": sent.hex(), "after_stdout_bytes": len(stdout),
                                    "observed_utc": datetime.now(timezone.utc).isoformat(),
                                    "eof_at_line_boundary": step.get("eof_at_line_boundary", False),
                                    "expected_prefix_bytes": len(expected)})
            assert os.write(master, sent) == len(sent), "PTY request was partially written"
            line_boundary = sent.endswith(b"\n")
            expected += step["response"].encode("utf-8")
            expect(expected)
        while active:
            receive()
        process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except Exception as error:
        timed_out = isinstance(error, (TimeoutError, subprocess.TimeoutExpired))
        failure = type(error).__name__ + ": " + str(error)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        # Preserve all available raw output even after a failed handshake.
        while active:
            ready, _, _ = select.select(list(active), [], [], 0)
            if not ready:
                break
            for descriptor in ready:
                try:
                    data = os.read(descriptor, 65536)
                except OSError as caught:
                    if descriptor == master and caught.errno == errno.EIO:
                        data = b""
                    else:
                        raise
                if data:
                    active[descriptor].extend(data)
                else:
                    del active[descriptor]
    finally:
        os.close(master)
        process.stderr.close()
    proof["protocol_failure"] = failure
    proof["finished_utc"] = datetime.now(timezone.utc).isoformat()
    return bytes(stdout), bytes(stderr), process.returncode, timed_out, proof, failure


def validate(command, stdout, stderr, code, timed_out, pty_failure):
    assert not timed_out and not pty_failure, "actual terminal/pipe execution failed: " + str(pty_failure)
    assert code == command["expected_exit"], "actual CLI OS exit differs from expected success/failure"
    assert stdout == command["expected_stdout"].encode("utf-8"), "exact actual transcript differs"
    if command["expected_exit"]:
        assert b"analysis::ExecutionAborted" in stderr and command["expected_abort"].encode() in stderr, "typed refusal did not reach genuine failing OS wrapper"
    else:
        assert stderr == b"", "successful product entry emitted unexpected stderr"
    if command["mode"] == "harness_chat":
        assert stdout.count(b" EVENT ") == 3 * command["expected_turns"], "chat admitted-turn event count changed"
        assert stdout.count(b" LEDGER ") == command["expected_turns"], "chat shared-ledger count changed"
        if command["expected_turns"]:
            ledger = ("TURN " + str(command["expected_turns"]) + " LEDGER maximum=16 spent=" + str(command["expected_spent"]) + " reserved=0\n").encode()
            assert ledger in stdout, "last admitted turn did not settle actual cumulative ledger"
    if command["mode"] == "harness":
        if command["admitted"]:
            assert stdout.count(b"EVENT ") == 3 and b"REFUSED " not in stdout, "B admitted exchange shape changed"
            assert stdout.endswith(("LEDGER maximum=5 spent=" + str(command["expected_spent"]) + " reserved=0\n").encode()), "B settlement changed"
        else:
            assert all(marker not in stdout for marker in [b"EVENT ", b"FINAL ", b"LEDGER "]), "B help/refusal unexpectedly delegated"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--etas", help="explicit absolute unchanged normal CLI; optional only for prepare-only")
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--prepare-only", action="store_true")
    options = parser.parse_args()
    if not 1 <= options.timeout <= 600:
        parser.error("timeout must be within 1..600 seconds")
    if not options.prepare_only and (not options.etas or not Path(options.etas).is_absolute()):
        parser.error("actual execution requires an absolute normal Etas executable")
    destination = options.evidence_dir.expanduser().resolve()
    if any(destination == path or path in destination.parents for path in [Path("/tmp"), Path("/private/tmp")]):
        parser.error("raw evidence must be persistent, not under /tmp")
    cases, paths = load_cases(), product_paths()
    runner_paths = [Path(__file__).resolve(), FIXTURE, OLD_FIXTURE, ROOT / "tests/harness_entry_probe.py",
                    ROOT / "tests/foundation_probe.py", ROOT / "tests/normal_graph_identity.py",
                    ROOT / "scripts/etas-0013-cli-bootstrap.py"]
    frozen_product, frozen_runner = input_hashes(paths), input_hashes(runner_paths)
    destination.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="harness002a-chat-", dir=destination))
    for source in paths + runner_paths:
        retain(source, evidence / "frozen-inputs" / source.relative_to(ROOT))
    save(evidence / "cases.json", cases)
    result = {"task": "HARNESS-002A", "scope": "actual fresh bounded chat pipe/PTY plus unchanged B/default composition; no durable/live/concurrent acceptance",
              "created_utc": datetime.now(timezone.utc).isoformat(), "product_root": str(ROOT), "status": "not_run",
              "prepared_only": options.prepare_only, "case_count": len(cases),
              "case_modes": {mode: sum(item["mode"] == mode for item in cases) for mode in ["harness_chat", "harness", "default"]},
              "transports": {transport: sum(item["transport"] == transport for item in cases) for transport in ["pipe", "pty"]},
              "product_sources_and_graph": frozen_product, "runner_inputs": frozen_runner, "cases_sha256": digest(evidence / "cases.json"),
              "ordinary_memory_limit_bytes": MEMORY_LIMIT, "cli_requested": options.etas, "cli_path": None, "cli_sha256": None,
              "commands": [dict(item, status="not_run") for item in cases]}
    output = evidence / "results.json"
    save(output, result)
    print("EVIDENCE " + str(evidence), flush=True)
    if options.prepare_only:
        print("NOT RUN: retained complete-root pending case matrix; no CLI/Etas dispatch", flush=True)
        return 0
    cli = Path(options.etas).resolve()
    result["initial_resources"] = resources()
    if not cli.is_file() or not os.access(cli, os.X_OK) or result["initial_resources"]["memory.max"] != str(MEMORY_LIMIT):
        result.update(status="pending_execution_environment", limitation="available absolute normal CLI and actual exactly 4-GiB cgroup required; no Etas command dispatched")
        save(output, result)
        return 2
    result["cli_path"], result["cli_sha256"], result["status"] = str(cli), digest(cli), "running"
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
            stdin = command["stdin"].encode("utf-8")
            (directory / "stdin.bin").write_bytes(stdin)
            save(directory / "case.json", cases[ordinal])
            before = resources()
            assert before["memory.max"] == str(MEMORY_LIMIT), "ordinary runtime ceiling changed"
            assert input_hashes(product_paths()) == frozen_product and input_hashes(runner_paths) == frozen_runner, "protected inputs changed"
            assert digest(cli) == result["cli_sha256"], "normal CLI binary changed"
            argv = [str(cli), "run", str(ROOT)]
            if command["mode"] != "default":
                argv += ["--flow", command["mode"]]
            argv += ["--profile", "foundation", "--allow-effects"]
            if command["args"]:
                argv += ["--args", *command["args"]]
            save(directory / "argv.json", argv)
            command.update(command=argv, resources_before=before, started_utc=datetime.now(timezone.utc).isoformat(), status="running")
            for name in ["stdin.bin", "case.json", "argv.json"]:
                command[name.split(".")[0] + "_sha256"] = digest(directory / name)
                command[name.split(".")[0] + "_retained"] = str((directory / name).relative_to(evidence))
            save(output, result)
            started = time.monotonic()
            observed = run_pty(argv, command, options.timeout) if command["transport"] == "pty" else run_pipe(argv, stdin, options.timeout)
            stdout, stderr, code, timed_out, terminal, pty_failure = observed
            (directory / "stdout.bin").write_bytes(stdout)
            (directory / "stderr.bin").write_bytes(stderr)
            if terminal is not None:
                save(directory / "terminal-observation.json", terminal)
                command.update(terminal_observation=terminal, terminal_sha256=digest(directory / "terminal-observation.json"),
                               terminal_retained=str((directory / "terminal-observation.json").relative_to(evidence)))
            after = resources()
            command.update(exit=code, timeout=timed_out, elapsed_seconds=time.monotonic() - started,
                           finished_utc=datetime.now(timezone.utc).isoformat(), resources_after=after,
                           stdout_base64=base64.b64encode(stdout).decode("ascii"), stderr_base64=base64.b64encode(stderr).decode("ascii"), status="observed")
            for name in ["stdout", "stderr"]:
                command[name + "_sha256"] = digest(directory / (name + ".bin"))
                command[name + "_retained"] = str((directory / (name + ".bin")).relative_to(evidence))
            save(output, result)
            validate(command, stdout, stderr, code, timed_out, pty_failure)
            if command["transport"] == "pty":
                assert terminal["proc_child_descriptors_observed"], "actual Linux product child TTY descriptors were not observed"
            assert after["memory.max"] == str(MEMORY_LIMIT) and pressure(before) == pressure(after), "ordinary memory ceiling/OOM events changed"
            assert input_hashes(product_paths()) == frozen_product and input_hashes(runner_paths) == frozen_runner, "protected inputs changed"
            command["status"] = "passed"
            save(output, result)
            print("PASS " + command["label"], flush=True)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        if "command" in locals():
            command["status"] = "failed"
    finally:
        try:
            unchanged_product = input_hashes(product_paths()) == frozen_product
            unchanged_runner = input_hashes(runner_paths) == frozen_runner
            unchanged_cli = cli.is_file() and digest(cli) == result["cli_sha256"]
        except (OSError, ValueError):
            unchanged_product = unchanged_runner = unchanged_cli = False
        complete = all(item["status"] == "passed" for item in result["commands"])
        result.update(status="passed" if complete and not failure and unchanged_product and unchanged_runner and unchanged_cli else "failed",
                      product_inputs_unchanged=unchanged_product, runner_inputs_unchanged=unchanged_runner, cli_unchanged=unchanged_cli,
                      final_resources=resources(), finished_utc=datetime.now(timezone.utc).isoformat())
        if failure:
            result["failure"] = failure
        save(output, result)
    if result["status"] != "passed":
        print("FAILED " + result.get("failure", "protected inputs changed"), flush=True)
        return 1
    print("PASS actual HARNESS-002A " + str(len(cases)) + " full-root pipe/PTY and unchanged B/default observations", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
