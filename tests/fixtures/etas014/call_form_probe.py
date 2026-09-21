#!/usr/bin/env python3
"""ETAS-014 paired diagnostic only; expected failure is not an upstream fix."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent


def main():
    for form in ("imported", "method"):
        for action in ("check", "run"):
            command = ["etas", action, str(ROOT / form)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=12)
            print("$ " + " ".join(command), flush=True)
            print(result.stdout, end="", flush=True)
            print(result.stderr, end="", flush=True)
            print(f"exit: {result.returncode}", flush=True)
            if action == "run" and form == "imported":
                assert result.returncode == 3, (form, result.returncode)
                assert "analysis::InvalidArguments" in result.stderr, result.stderr
                assert "import alias does not name a runtime value" in result.stderr, result.stderr
                assert '"value":"2"' not in result.stdout, result.stdout
                print("OBSERVED imported call runtime rejection (not a passing language regression)", flush=True)
            else:
                assert result.returncode == 0 and result.stderr == "", (form, action, result)
                if action == "run":
                    assert '"kind":"number","type":"i32","value":"2"' in result.stdout, result.stdout
                else:
                    assert "checked 1 file" in result.stdout, result.stdout
                print(f"PASS {form} {action}", flush=True)


if __name__ == "__main__":
    main()
