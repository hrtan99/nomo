#!/usr/bin/env python3
"""Provision or inspect only the fixed private LOCAL-TRYOUT-001 mount tree."""
import argparse
import os
from pathlib import Path
import stat
import sys

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/local_tryout001"
MARKER = ".nomo-local-tryout"
MARKER_BYTES = b"nomo-local-tryout-v1\n"
CONTEXT = Path("context/demo/context.txt")
WORKSPACE = Path("workspace/demo/value.txt")


def location(value):
    requested = Path(value).expanduser()
    if requested.name in ("", ".", ".."):
        raise ValueError("an explicit new tryout directory name is required")
    # Resolve the existing parent (including macOS /tmp), never the root leaf.
    base = requested.parent.resolve(strict=True) / requested.name
    if any(ord(character) < 32 or ord(character) == 127 for character in str(base)):
        raise ValueError("tryout paths must not contain control characters")
    return base


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise ValueError("tryout directories must be owned, non-symlink directories")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("tryout directories must retain private mode 0700")


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("tryout leaves must be non-symlink, single-link regular files")
    return info


def private_file(path):
    info = regular(path)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("fixed tryout metadata/context must retain owner-only mode 0600")


def entries(path, expected):
    if {item.name for item in path.iterdir()} != set(expected):
        raise ValueError("tryout layout differs from the fixed template")


def check(value):
    base = location(value)
    for name in [Path("."), Path("context"), Path("context/demo"), Path("workspace"), Path("workspace/demo"), Path("state")]:
        directory(base / name)
    entries(base, [MARKER, "context", "workspace", "state"])
    entries(base / "context", ["demo"])
    entries(base / "context/demo", ["context.txt"])
    entries(base / "workspace", ["demo"])
    entries(base / "workspace/demo", ["value.txt"])
    private_file(base / MARKER)
    private_file(base / CONTEXT)
    if (base / MARKER).read_bytes() != MARKER_BYTES or (base / CONTEXT).read_bytes() != b"blue\n":
        raise ValueError("fixed tryout marker or context template differs")
    # The native File adapter may replace this leaf and its metadata. The
    # private ancestor remains the boundary; no application contents are read.
    regular(base / WORKSPACE)
    # SQLite and optional trace files are opaque engineering payloads. Do not
    # inspect their schema, phase, allowance, outcome or success markers here.
    for item in (base / "state").iterdir():
        regular(item)
    return base


def write_new(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(data)


def prepare(value):
    base = location(value)
    templates = [(CONTEXT, b"blue\n"), (WORKSPACE, b"old\n")]
    for name, expected in templates:
        if (FIXTURE / name).read_bytes() != expected:
            raise ValueError("repository tryout fixture differs from the fixed template")
    # mkdir itself is the exclusive claim. Existing files, directories and even
    # dangling symlinks are collisions; never reset, chmod or remove them.
    try:
        base.mkdir(mode=0o700)
    except FileExistsError as error:
        raise ValueError("tryout directory already exists; existing data was preserved") from error
    os.chmod(base, 0o700)
    for name in ["context", "context/demo", "workspace", "workspace/demo", "state"]:
        target = base / name
        target.mkdir(mode=0o700)
        os.chmod(target, 0o700)
    for name, expected in templates:
        write_new(base / name, expected)
    # A failed preparation is left intact for inspection and never repaired.
    # Only a fully written layout receives its final ownership marker.
    write_new(base / MARKER, MARKER_BYTES)
    return check(base)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read-only structural mount preflight")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        base = check(args.directory) if args.check else prepare(args.directory)
    except (OSError, ValueError) as error:
        print("REFUSED local tryout setup: " + str(error), file=sys.stderr)
        return 64
    print(base)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
