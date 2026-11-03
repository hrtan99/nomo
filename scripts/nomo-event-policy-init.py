#!/usr/bin/env python3
"""Create a random binding key in an explicitly selected private policy directory."""
import argparse
import os
from pathlib import Path
import stat
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()
    try:
        path = Path(args.directory)
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
        print('Created private binding.key. Keep it with your private policy.json; losing it prevents matching recorded sessions.')
        return 0
    except (OSError, ValueError) as error:
        print('REFUSED ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
