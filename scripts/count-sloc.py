#!/usr/bin/env python3
"""nomo-physical-v4: count every currently supported handwritten runtime path."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
PRODUCT_ROOTS = ("src",)
OTHER_ROOTS = ("tests", "examples", "scripts")
RUNTIME_GROUPS = {
    "entry": ("scripts/nomo",),
    "transport": ("scripts/terminal-transport.py",),
    "native": ("scripts/nomo-native", "scripts/native-worker-transport.py", "scripts/nomo-migrate-native", "scripts/nomo_migration.py"),
    "gateway": ("scripts/etas003_gateway.py",),
    "tryout": (
        "scripts/local-tryout.sh", "scripts/prepare-local-tryout.py",
        "scripts/session-demo.sh",
    ),
}
RUNTIME_FILES = tuple(name for names in RUNTIME_GROUPS.values() for name in names)
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


def count_files(paths):
    sloc = raw = 0
    for path in paths:
        lines = path.read_text().splitlines()
        raw += len(lines)
        sloc += sum(bool(line.strip()) and not line.lstrip().startswith(("#", "//")) for line in lines)
    return sloc, raw, len(paths)


def total(*values):
    return tuple(sum(value[index] for value in values) for index in range(3))


def difference(left, right):
    return tuple(left[index] - right[index] for index in range(3))


def inventory(root):
    retired = root / "packages/session-store/src"
    if count(retired)[2]:
        raise ValueError("retired product root still contains counted sources: packages/session-store/src")
    missing = [name for name in PRODUCT_ROOTS + OTHER_ROOTS if not (root / name).is_dir()]
    if missing:
        raise ValueError("authoritative inventory requires directories: " + ", ".join(missing))
    runtime = tuple(root / name for name in RUNTIME_FILES)
    missing_runtime = [name for name, path in zip(RUNTIME_FILES, runtime) if not path.is_file()]
    if missing_runtime:
        raise ValueError("authoritative inventory requires runtime files: " + ", ".join(missing_runtime))
    counts = {name: count(root / name) for name in PRODUCT_ROOTS + OTHER_ROOTS}
    counts["runtime"] = count_files(runtime)
    counts.update(("runtime-" + name, count_files(tuple(root / path for path in paths)))
                  for name, paths in RUNTIME_GROUPS.items())
    counts["product"] = total(*(counts[name] for name in PRODUCT_ROOTS), counts["runtime"])
    counted_runtime_scripts = count_files(tuple(path for path in runtime if path.suffix in SUFFIXES))
    counts["engineering-scripts"] = difference(counts["scripts"], counted_runtime_scripts)
    counts["scripts"] = total(counts["scripts"], count_files(tuple(path for path in runtime if path.suffix not in SUFFIXES)))
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
    print("counter: nomo-physical-v4; authoritative; blank and comment-only # / // lines excluded")
    print("product roots: " + ", ".join(PRODUCT_ROOTS) + "; reviewed runtime inventory: " + ", ".join(RUNTIME_FILES))
    groups = tuple("runtime-" + name for name in RUNTIME_GROUPS)
    for name in PRODUCT_ROOTS + ("runtime",) + groups + ("product",) + OTHER_ROOTS + ("engineering-scripts",):
        report(name, counts[name])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
