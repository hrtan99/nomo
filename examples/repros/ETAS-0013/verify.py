#!/usr/bin/env python3
"""Record and assert ETAS-0013 observations; no storage or project imports.

Exit 0 means the documented software bug was reproduced, not fixed.
All generated packages and CLI outputs are retained in a fresh directory.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
EXPECTED_CLI_SHA256 = "d132effe40b47ca023642ec1c1d09f4498bfceccd51d41e18fddd45c5fc288e2"
MARKER = "PUBLIC_CONSTRUCTOR_OK"
DIAGNOSTIC = "error[analysis::InvalidArguments]: import alias does not name a runtime value"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cli", type=Path)
    parser.add_argument("--evidence-root", type=Path, required=True)
    args = parser.parse_args()
    cli = args.cli.resolve()
    digest = hashlib.sha256(cli.read_bytes()).hexdigest()
    if digest != EXPECTED_CLI_SHA256:
        raise SystemExit("CLI identity mismatch; this observer asserts only the recorded affected binary")
    evidence = Path(tempfile.mkdtemp(prefix="match-repro-", dir=args.evidence_root))
    manifest = (ROOT / "etas.toml").read_text()
    original = (ROOT / "src/app/main.es").read_text()
    imported = "import std.memory.{version, Match};"
    expression = "    let condition = Match(observed);"
    cases = [
        ("version-control", "import std.memory.version;",
         '    if observed.opaque != "synthetic-version-only-not-backend-evidence" { return 1; }', 0),
        ("missing-control", "import std.memory.{version, Missing};", "    let condition = Missing;", 0),
        ("imported-match", imported, expression, 3),
        ("qualified-match", "import std.memory.version;", "    let condition = std.memory.Match(observed);", 3),
        ("type-qualified-match", "import std.memory.{version, WriteCondition};", "    let condition = WriteCondition.Match(observed);", 3),
        ("fully-type-qualified-match", "import std.memory.version;", "    let condition = std.memory.WriteCondition.Match(observed);", 3),
    ]
    results = {"cli_sha256": digest, "platform": platform.platform(),
               "machine": platform.machine(), "scope": "constructors only; no database or commit",
               "meaning": "passing assertions confirm the recorded software bug, not a fix", "cases": []}
    version = subprocess.run([str(cli), "--version"], capture_output=True, text=True, timeout=15, check=True)
    results["cli_version"] = version.stdout.strip()
    failures = []
    for name, replacement_import, replacement_expression, expected_exit in cases:
        project = evidence / name
        (project / "src/app").mkdir(parents=True)
        source = original.replace(imported, replacement_import).replace(expression, replacement_expression)
        (project / "src/app/main.es").write_text(source)
        (project / "etas.toml").write_text(manifest)
        result = {"name": name, "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                  "manifest_sha256": hashlib.sha256(manifest.encode()).hexdigest(), "commands": []}
        for arguments in [["check", "--all", str(project)], ["run", str(project), "--allow-effects"]]:
            command = [str(cli), *arguments]
            run = subprocess.run(command, capture_output=True, text=True, timeout=45)
            result["commands"].append({"command": command, "exit": run.returncode,
                                       "stdout": run.stdout, "stderr": run.stderr})
        checked, ran = result["commands"]
        matched = checked["exit"] == 0 and ran["exit"] == expected_exit
        matched = matched and (MARKER in ran["stdout"] if expected_exit == 0 else
                               DIAGNOSTIC in ran["stderr"] and MARKER not in ran["stdout"])
        result["matches_recorded_observation"] = matched
        results["cases"].append(result)
        if not matched:
            failures.append(name)
        (evidence / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(f"{name}: check={checked['exit']} run={ran['exit']} observation={'matched' if matched else 'DIFFERENT'}", flush=True)
    results["all_observations_matched"] = not failures
    (evidence / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"EVIDENCE {evidence}", flush=True)
    if failures:
        raise SystemExit("Unexpected observations: " + ", ".join(failures))


if __name__ == "__main__":
    main()
