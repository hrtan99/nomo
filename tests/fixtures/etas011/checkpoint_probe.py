#!/usr/bin/env python3
"""ETAS-011: resume rebuilds current File regions, not persisted authority."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def roots(value):
    if isinstance(value, dict):
        if "canonical_root" in value:
            yield value
        for child in value.values():
            yield from roots(child)
    elif isinstance(value, list):
        for child in value:
            yield from roots(child)


def run(*arguments):
    return subprocess.run(["etas", *arguments], capture_output=True, timeout=10)


def main():
    with tempfile.TemporaryDirectory(prefix="nomo-etas011-checkpoint-") as temporary:
        root = Path(temporary)
        project = root / "project"
        shutil.copytree(Path(__file__).parents[1] / "etas010/source_project", project)
        workspace = project / "workspace"
        workspace.mkdir()
        shutil.copyfile(project / "input.txt", workspace / "input.txt")
        manifest = project / "etas.toml"
        manifest.write_text(manifest.read_text().replace('root = "."', 'root = "workspace"'))
        checkpoints = root / "checkpoints"
        initial = run("run", str(project), "--profile", "allowed", "--allow-effects",
                      "--checkpoint-dir", str(checkpoints), "--args", str(root / "marker"))
        assert initial.returncode == 0, initial.stderr
        artifact_path = checkpoints / "checkpoint-0.json"
        original = json.loads(artifact_path.read_text())
        assert not list(roots(original)), "ordinary checkpoint must not retain invocation roots"
        assert set(original["checkpoint"]["host_state"]) == {"trace", "budget"}
        print("CASE checkpoint_omits_invocation_authority\nRESULT pass\n")
        valid = run("resume", "0", "--checkpoint-dir", str(checkpoints))
        assert valid.returncode == 0, valid.stderr
        print("CASE checkpoint_existing_directory_root\nRESULT pass\n")

        saved = project / "saved-workspace"
        workspace.rename(saved)
        try:
            for name in ["missing", "file"]:
                if name == "file":
                    workspace.write_text("fixture-owned file")
                result = run("resume", "0", "--checkpoint-dir", str(checkpoints))
                assert result.returncode == 2, (name, result.returncode, result.stderr)
                assert not result.stdout, result.stdout
                assert b"invalid runtime filesystem workspace root" in result.stderr, result.stderr
                print(f"CASE checkpoint_{name}_root_rejected\nRESULT pass\n")
        finally:
            if workspace.is_file():
                workspace.unlink()
            saved.rename(workspace)

        assert json.loads(artifact_path.read_text()) == original
        restored = run("resume", "0", "--checkpoint-dir", str(checkpoints))
        assert restored.returncode == 0, restored.stderr
        print("CASE checkpoint_valid_root_restored\nRESULT pass\n")


if __name__ == "__main__":
    main()
