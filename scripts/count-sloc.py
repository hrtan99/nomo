#!/usr/bin/env python3
"""nomo-physical-v2: explicit product roots; unchanged physical-line convention."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
PRODUCT_ROOTS = ("src", "packages/session-store/src")
OTHER_ROOTS = ("tests", "examples", "scripts")
SUFFIXES = {".es", ".rs", ".py", ".sh"}
EXCLUDED = {"target", "node_modules", ".git", "__pycache__"}


def count(directory):
    sloc = raw = files = 0
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if path.suffix not in SUFFIXES or EXCLUDED.intersection(relative.parts) or not path.is_file():
            continue
        lines = path.read_text().splitlines()
        files += 1
        raw += len(lines)
        sloc += sum(bool(line.strip()) and not line.lstrip().startswith(("#", "//")) for line in lines)
    return sloc, raw, files


def inventory(root):
    missing = [name for name in PRODUCT_ROOTS + OTHER_ROOTS if not (root / name).is_dir()]
    if missing:
        raise ValueError("authoritative inventory requires directories: " + ", ".join(missing))
    counts = {name: count(root / name) for name in PRODUCT_ROOTS + OTHER_ROOTS}
    counts["product"] = tuple(sum(counts[name][index] for name in PRODUCT_ROOTS) for index in range(3))
    return counts


def report(name, values):
    sloc, raw, files = values
    print(f"{name}: {sloc} SLOC, {raw} raw lines, {files} files")


def main():
    try:
        counts = inventory(ROOT)
    except ValueError as error:
        print(f"SLOC error: {error}", file=sys.stderr)
        return 2
    print("counter: nomo-physical-v2; authoritative; blank and comment-only # / // lines excluded")
    print("product roots: " + ", ".join(PRODUCT_ROOTS) + "; product is their combined total")
    for name in PRODUCT_ROOTS + ("product",) + OTHER_ROOTS:
        report(name, counts[name])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
