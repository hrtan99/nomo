#!/usr/bin/env python3
"""Read an owner-only event policy and bind its exact bytes with a private key."""
import argparse
import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
import sys


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


def write_tmp(directory, data):
    target = Path(directory)
    target.mkdir(mode=0o700)
    fd = os.open(target / 'policy.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:raise OSError('private policy transfer failed')
            view = view[written:]
    finally:os.close(fd)


def initialize(directory):
    path = Path(directory)
    if not path.is_absolute() or path.is_symlink():raise ValueError('select an absolute, non-symlink policy directory')
    root = os.open(path.resolve(strict=True), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(root)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:raise ValueError('policy directory must be owned by you with mode 0700')
        fd = os.open('binding.key', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=root)
        try:
            key = os.urandom(32)
            if os.write(fd, key) != len(key):raise OSError('binding key write incomplete')
            os.fsync(fd)
        finally:os.close(fd)
        os.fsync(root)
    finally:os.close(root)


def prepare(source, target, expected):
    if not re.fullmatch(r'[0-9a-f]{64}', expected):raise ValueError('invalid policy binding')
    _, data, actual = read_private(source)
    if not hmac.compare_digest(actual, expected):raise ValueError('event policy changed before dispatch')
    write_tmp(target, data)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    action = args.pop(0) if args else ''
    if action == 'init':
        parser = argparse.ArgumentParser(description='Create a private event-policy binding key.')
        parser.add_argument('--directory', required=True)
        selected = parser.parse_args(args)
        try:initialize(selected.directory)
        except (OSError, ValueError) as error:
            print('REFUSED ' + str(error), file=sys.stderr);return 1
        print('Created private binding.key. Keep it with your private policy.json; losing it prevents matching recorded sessions.')
        return 0
    if action == 'stdin-bootstrap':
        data = sys.stdin.buffer.read(4097)
        if not 1 <= len(data) <= 4096:raise SystemExit('invalid private event policy transfer')
        write_tmp('/tmp/nomo-event-policy', data)
        command = args
    elif action == 'mount-bootstrap':
        if len(args) < 2:raise SystemExit('event policy binding and command required')
        try:prepare('/event-policy-source', '/tmp/nomo-event-policy', args[0])
        except (OSError, ValueError):
            print('REFUSED private event policy unavailable or changed before dispatch', file=sys.stderr, flush=True);return 1
        command = args[1:]
    else:raise SystemExit('expected init, stdin-bootstrap or mount-bootstrap')
    os.execv(sys.executable, [sys.executable, '-B', '/workspace/scripts/nomo-verified-etas.py', *command])


if __name__ == '__main__':raise SystemExit(main())
