#!/usr/bin/env python3
"""nomo-physical-v1: existing provisional counts; TL/QA policy sign-off pending."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUFFIXES = {".es", ".rs", ".py", ".sh"}
EXCLUDED = {"target", "node_modules", ".git", "__pycache__"}


def main():
    print("counter: nomo-physical-v1; blank and comment-only # / // lines excluded")
    for category in ("src", "tests", "examples", "scripts"):
        sloc = raw = files = 0
        for path in sorted((ROOT / category).rglob("*")):
            if path.suffix not in SUFFIXES or EXCLUDED.intersection(path.parts) or not path.is_file():
                continue
            lines = path.read_text().splitlines()
            files += 1
            raw += len(lines)
            sloc += sum(bool(line.strip()) and not line.lstrip().startswith(("#", "//")) for line in lines)
        print(f"{category}: {sloc} SLOC, {raw} raw lines, {files} files")


if __name__ == "__main__":
    main()
