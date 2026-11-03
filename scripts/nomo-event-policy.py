#!/usr/bin/env python3
"""Read an owner-only event policy and bind its exact bytes with a private key."""
import hashlib
import hmac
import os
from pathlib import Path
import stat


def read_private(directory):
    path = Path(directory)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError('event policy directory must be absolute and not a symlink')
    path = path.resolve(strict=True)
    root = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(root)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('event policy directory must be owned by you with mode 0700')

        def read(name, limit):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=root)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600 or not 1 <= before.st_size <= limit:
                    raise ValueError('event policy files must be owned, private, single-link regular files within size limits')
                chunks = []
                remaining = limit + 1
                while remaining:
                    data = os.read(fd, remaining)
                    if not data:break
                    chunks.append(data);remaining -= len(data)
                value = b''.join(chunks)
                after = os.fstat(fd)
                signature = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
                if len(value) != before.st_size or signature(before) != signature(after):
                    raise ValueError('event policy file changed during read')
                return value
            finally:os.close(fd)

        policy = read('policy.json', 4096)
        key = read('binding.key', 32)
        if len(key) != 32:raise ValueError('event policy binding key must contain exactly 32 random bytes')
        binding = hmac.new(key, b'nomo-event-policy-v1\0' + policy, hashlib.sha256).hexdigest()
        return path, policy, binding
    finally:os.close(root)
