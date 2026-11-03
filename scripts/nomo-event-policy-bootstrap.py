#!/usr/bin/env python3
"""Place the private policy on container tmpfs, then exec the verified CLI."""
import os
from pathlib import Path
import sys

data = sys.stdin.buffer.read(4097)
if not 1 <= len(data) <= 4096:
    raise SystemExit('invalid private event policy transfer')
directory = Path('/tmp/nomo-event-policy')
directory.mkdir(mode=0o700)
fd = os.open(directory / 'policy.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
try:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:raise OSError('private policy transfer failed')
        view = view[written:]
finally:os.close(fd)
os.execv(sys.executable, [sys.executable, '-B', '/workspace/scripts/nomo-verified-etas.py', *sys.argv[1:]])
