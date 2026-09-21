#!/usr/bin/env python3
"""ETAS-0003/0007: public constructors through normal main and real Hosts."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def values(node):
    if isinstance(node, dict):
        yield node
        for child in node.values():
            yield from values(child)
    elif isinstance(node, list):
        for child in node:
            yield from values(child)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--etas", default="etas")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="etas010-source-") as root:
        root = Path(root)
        project = root / "project"
        shutil.copytree(Path(__file__).parent / "source_project", project)
        checked = subprocess.run([args.etas, "check", str(project)], capture_output=True, timeout=5)
        assert checked.returncode == 0, checked.stderr
        for profile in ["allowed", "denied", "not-allowlisted", "file-denied"]:
            marker = root / f"{profile}.marker"
            checkpoints = root / profile
            result = subprocess.run([
                args.etas, "run", str(project), "--profile", profile, "--allow-effects",
                "--checkpoint-dir", str(checkpoints), "--args", str(marker),
            ], capture_output=True, timeout=5)
            if profile == "allowed":
                assert result.returncode == 0, result.stderr
                assert marker.read_bytes() == b"spawned"
                artifact = json.loads((checkpoints / "checkpoint-0.json").read_text())
                commands = [v for v in values(artifact) if v.get("kind") == "command_result"]
                assert commands, "checkpoint must contain actual command outcome"
                for command in commands:
                    assert command["exit_code"] == 7, command
                    assert bytes(command["stdout"]) == b"argument with spaces|explicit|ETAS010_INPUT", command
                    assert bytes(command["stderr"]) == b"unset|unset", command
                print("CASE ETAS-0003_public_path_read\nRESULT pass\n")
                print("CASE ETAS-0007_public_command_main\nRESULT pass\n")
            else:
                assert result.returncode != 0, (profile, result.stdout)
                assert not marker.exists(), f"{profile} started a denied command"
                expected_error = {
                    "denied": b"policy denied",
                    "not-allowlisted": b"not allowlisted",
                    "file-denied": b"grant",
                }[profile]
                assert expected_error in result.stderr.lower(), result.stderr
                print(f"CASE source_{profile}\nRESULT pass\n")

        checkpoints = root / "repeated"
        result = subprocess.run([
            args.etas, "run", str(project), "--flow", "repeated", "--profile", "console",
            "--allow-effects", "--checkpoint-dir", str(checkpoints),
        ], capture_output=True, timeout=5)
        assert result.returncode == 0, result.stderr
        assert result.stdout == b"SAME\n" * 4, result.stdout
        for checkpoint_id, remaining in [(0, 3), (1, 1), (2, 0)]:
            artifact = json.loads((checkpoints / f"checkpoint-{checkpoint_id}.json").read_text())
            ledger = artifact["checkpoint"]["completed_host_boundaries"]
            assert len({json.dumps(item["occurrence"], sort_keys=True) for item in ledger}) == len(ledger)
            resumed = subprocess.run([
                args.etas, "resume", str(checkpoint_id), "--checkpoint-dir", str(checkpoints),
            ], capture_output=True, timeout=5)
            assert resumed.returncode == 0, resumed.stderr
            assert resumed.stdout.count(b"SAME\n") == remaining, resumed.stdout
        print("CASE ETAS-0008_identical_writes_loop_resume\nRESULT pass\n")


if __name__ == "__main__":
    main()
