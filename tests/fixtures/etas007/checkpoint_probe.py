#!/usr/bin/env python3
"""Black-box checkpoint and restart checks for ETAS-007."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    input_data: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        argv,
        cwd=cwd,
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )


def expect(
    name: str,
    result: subprocess.CompletedProcess[bytes],
    code: int,
    stdout: bytes | None = None,
    stderr_contains: bytes | None = None,
) -> None:
    if result.returncode != code:
        raise AssertionError(
            f"{name}: exit={result.returncode}, stdout={result.stdout!r}, "
            f"stderr={result.stderr!r}"
        )
    if stdout is not None and result.stdout != stdout:
        raise AssertionError(f"{name}: stdout={result.stdout!r}")
    if stderr_contains is not None and stderr_contains not in result.stderr:
        raise AssertionError(f"{name}: stderr={result.stderr!r}")
    print(f"CASE {name}\nEXIT {code}\nRESULT pass\n")


def command(etas: str, project: Path, *extra: str) -> list[str]:
    return [
        etas,
        "run",
        str(project),
        "--profile",
        "checkpoint",
        "--allow-effects",
        "--color",
        "never",
        *extra,
    ]


def resume(
    etas: str,
    checkpoint_id: int,
    checkpoint_dir: Path,
    *extra: str,
) -> list[str]:
    return [
        etas,
        "resume",
        str(checkpoint_id),
        "--checkpoint-dir",
        str(checkpoint_dir),
        "--color",
        "never",
        *extra,
    ]


def load(path: Path) -> dict[str, object]:
    with path.open(encoding="utf-8") as checkpoint_file:
        return json.load(checkpoint_file)


def save(path: Path, value: dict[str, object]) -> None:
    with path.open("w", encoding="utf-8") as checkpoint_file:
        json.dump(value, checkpoint_file)


def copied_checkpoint(checkpoint_zero: Path, checkpoint_dir: Path, target_id: int) -> Path:
    target = checkpoint_dir / f"checkpoint-{target_id}.json"
    shutil.copyfile(checkpoint_zero, target)
    return target


def assert_artifacts(checkpoint_dir: Path) -> tuple[Path, Path]:
    paths = sorted(path.name for path in checkpoint_dir.iterdir())
    if paths != ["checkpoint-0.json", "checkpoint-1.json"]:
        raise AssertionError(f"unexpected checkpoint files: {paths}")
    if any(".tmp." in path for path in paths):
        raise AssertionError(f"temporary checkpoint survived atomic write: {paths}")
    print("CASE atomic_checkpoint_files\nEXIT 0\nRESULT pass\n")
    return checkpoint_dir / paths[0], checkpoint_dir / paths[1]


def assert_checkpoint_shape(
    checkpoint_zero: Path,
    checkpoint_one: Path,
    source_path: Path,
) -> None:
    first = load(checkpoint_zero)
    second = load(checkpoint_one)
    if first["schema"] != "etas.cli.interpreter-checkpoint.v15":
        raise AssertionError(f"unexpected schema: {first['schema']!r}")
    if first["flow"] != "main" or first["sources"] != [str(source_path)]:
        raise AssertionError("checkpoint does not preserve its source/flow identity")

    first_state = first["checkpoint"]
    second_state = second["checkpoint"]
    assert isinstance(first_state, dict)
    assert isinstance(second_state, dict)
    if (first_state["id"], first_state["label"]) != (0, "after-before"):
        raise AssertionError("first checkpoint identity changed")
    if (second_state["id"], second_state["label"]) != (1, "after-after"):
        raise AssertionError("second checkpoint identity changed")

    first_ledger = first_state["completed_host_boundaries"]
    second_ledger = second_state["completed_host_boundaries"]
    assert isinstance(first_ledger, list)
    assert isinstance(second_ledger, list)
    if [entry["key"] for entry in first_ledger] != ["console:stdout:true:BEFORE"]:
        raise AssertionError(f"unexpected first completion ledger: {first_ledger!r}")
    if [entry["key"] for entry in second_ledger] != [
        "console:stdout:true:BEFORE",
        "console:stdout:true:AFTER",
    ]:
        raise AssertionError(f"unexpected second completion ledger: {second_ledger!r}")
    if {entry["result"]["kind"] for entry in second_ledger} - {"runtime", "host"}:
        raise AssertionError("unexpected completed-boundary result kind")

    budget = first_state["host_state"]["budget"]
    if budget["limits"] != {
        "cost": {"currency": "USD", "max_micros": "1000"},
        "time": {"max_millis": 600_000},
        "tokens": {"max_tokens": 100},
    }:
        raise AssertionError(f"budget limits missing from checkpoint: {budget!r}")
    if not int(budget["state"]["deadline_unix_millis"]):
        raise AssertionError("checkpoint lacks an absolute budget deadline")

    if first_state["current_session"] is not None:
        raise AssertionError("fixture unexpectedly has an Etas session adapter")
    if first["runtime_profile"]["workspace_root"] is not None:
        raise AssertionError("fixture unexpectedly has a Host workspace root")
    for application_field in ("transcript", "lifecycle", "workspace_id"):
        if application_field in first or application_field in first_state:
            raise AssertionError(f"unexpected application-owned field: {application_field}")
    print("CASE checkpoint_schema_and_state\nEXIT 0\nRESULT pass\n")


def mutate_manifest_profile(project: Path) -> None:
    manifest = project / "etas.toml"
    text = manifest.read_text(encoding="utf-8")
    manifest.write_text(text.replace('mode = "deny"', 'mode = "auto"'), encoding="utf-8")


def mutate_source(source: Path) -> None:
    with source.open("a", encoding="utf-8") as source_file:
        source_file.write("\nflow added_after_checkpoint() -> i32 { return 7; }\n")


def assert_interrupted_checkpoint_is_not_durable(
    etas: str,
    project: Path,
    work_root: Path,
) -> None:
    checkpoint_dir = work_root / "interrupted-checkpoints"
    process = subprocess.Popen(
        command(
            etas,
            project,
            "--flow",
            "blocking",
            "--checkpoint-dir",
            str(checkpoint_dir),
        ),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    assert process.stdout is not None
    ready = process.stdout.readline()
    if ready != b"BLOCKING_READY\n":
        process.kill()
        raise AssertionError(f"blocking flow did not reach checkpoint: {ready!r}")
    time.sleep(0.1)
    os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=2)
    if process.returncode != -signal.SIGKILL:
        raise AssertionError(f"blocking flow exit changed: {process.returncode}")
    artifacts = list(checkpoint_dir.glob("*")) if checkpoint_dir.exists() else []
    if artifacts:
        raise AssertionError(f"interrupted run persisted unexpected files: {artifacts}")
    print(
        "CASE interrupted_checkpoint_persistence\n"
        "EXIT signal:SIGKILL\n"
        "RESULT bounded-gap\n"
        "DETAIL checkpoint() is retained in memory and no artifact exists until etas run returns\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--etas", required=True)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--work-root", required=True, type=Path)
    args = parser.parse_args()

    project = args.work_root / "project"
    shutil.copytree(args.fixture, project)
    source = project / "src/app/main.es"
    checkpoint_dir = args.work_root / "checkpoints"

    checked = run([args.etas, "check", str(project)])
    expect("checkpoint_project_check", checked, 0, b"checked 1 file\n")

    initial = run(
        command(
            args.etas,
            project,
            "--budget-tokens",
            "100",
            "--budget-cost",
            "USD:1000",
            "--budget-time",
            "600000",
            "--checkpoint-dir",
            str(checkpoint_dir),
        )
    )
    expect("initial_checkpoint_run", initial, 0, b"BEFORE\nAFTER\n")
    checkpoint_zero, checkpoint_one = assert_artifacts(checkpoint_dir)
    assert_checkpoint_shape(checkpoint_zero, checkpoint_one, source)

    resumed_zero = run(resume(args.etas, 0, checkpoint_dir))
    expect(
        "restart_resume_from_first",
        resumed_zero,
        0,
        b'AFTER\nresumed checkpoint 0: {"kind":"number","type":"i32","value":"42"}\n'
        b"events: 5, checkpoints: 1\n",
    )
    resumed_one = run(resume(args.etas, 1, checkpoint_dir))
    expect(
        "restart_resume_from_second",
        resumed_one,
        0,
        b'resumed checkpoint 1: {"kind":"number","type":"i32","value":"42"}\n'
        b"events: 0, checkpoints: 0\n",
    )

    checkpoint_one.unlink()
    resumed_without_write = run(resume(args.etas, 0, checkpoint_dir))
    if resumed_without_write.returncode != 0 or checkpoint_one.exists():
        raise AssertionError("etas resume unexpectedly persisted its new checkpoint")
    print(
        "CASE resumed_checkpoint_persistence\n"
        "EXIT 0\n"
        "RESULT bounded-gap\n"
        "DETAIL etas resume reports one new checkpoint but does not write checkpoint-1.json\n"
    )

    other_workspace = args.work_root / "other-workspace"
    other_workspace.mkdir()
    workspace_result = run(
        resume(args.etas, 0, checkpoint_dir, "--workspace", str(other_workspace)),
        cwd=other_workspace,
    )
    if workspace_result.returncode != 0:
        raise AssertionError(
            f"unrelated current workspace changed resume result: {workspace_result.stderr!r}"
        )
    print(
        "CASE application_workspace_binding\n"
        "EXIT 0\n"
        "RESULT bounded-gap\n"
        "DETAIL artifact uses embedded absolute source paths and has no application workspace identity\n"
    )

    original_manifest = (project / "etas.toml").read_text(encoding="utf-8")
    copied_checkpoint(checkpoint_zero, checkpoint_dir, 2)
    mutate_manifest_profile(project)
    profile_result = run(resume(args.etas, 2, checkpoint_dir))
    expect(
        "runtime_profile_change_fails_closed",
        profile_result,
        2,
        stderr_contains=b"current host runtime profile is not compatible with the checkpoint",
    )
    (project / "etas.toml").write_text(original_manifest, encoding="utf-8")

    original_source = source.read_text(encoding="utf-8")
    copied_checkpoint(checkpoint_zero, checkpoint_dir, 3)
    mutate_source(source)
    source_result = run(resume(args.etas, 3, checkpoint_dir))
    if source_result.returncode != 2 or b"fingerprint" not in source_result.stderr:
        raise AssertionError(
            f"source drift did not fail closed: exit={source_result.returncode}, "
            f"stderr={source_result.stderr!r}"
        )
    print("CASE source_identity_change_fails_closed\nEXIT 2\nRESULT pass\n")
    source.write_text(original_source, encoding="utf-8")

    schema_path = copied_checkpoint(checkpoint_zero, checkpoint_dir, 4)
    future_schema = load(schema_path)
    future_schema["schema"] = "etas.cli.interpreter-checkpoint.v999"
    save(schema_path, future_schema)
    schema_result = run(resume(args.etas, 4, checkpoint_dir))
    expect(
        "unsupported_schema_fails_closed",
        schema_result,
        2,
        stderr_contains=b"unsupported checkpoint artifact schema",
    )

    corrupt_path = checkpoint_dir / "checkpoint-5.json"
    corrupt_path.write_bytes(b"{")
    corrupt_result = run(resume(args.etas, 5, checkpoint_dir))
    expect(
        "corrupt_json_fails_closed",
        corrupt_result,
        2,
        stderr_contains=b"checkpoint artifact is not valid JSON",
    )

    missing_result = run(resume(args.etas, 99, checkpoint_dir))
    if missing_result.returncode != 2:
        raise AssertionError(f"missing checkpoint exit changed: {missing_result.returncode}")
    print("CASE missing_checkpoint_fails_closed\nEXIT 2\nRESULT pass\n")

    assert_interrupted_checkpoint_is_not_durable(args.etas, project, args.work_root)
    print("ETAS-007 checkpoint probe completed: 11 pass, 3 bounded gaps")


if __name__ == "__main__":
    main()
