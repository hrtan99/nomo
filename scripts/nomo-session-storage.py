#!/usr/bin/env python3
"""Apply private mode bits to an owned SQLite session while its lock is held."""
import os,stat

def prepare(state, *, create=False):
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
    directory=os.open(state,flags)
    try:
        info=os.fstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:
            raise ValueError('session state must be owned by you with mode 0700')
        base='history.sqlite3'
        if create:
            fd=os.open(base,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1:raise ValueError('new session database is not a private regular file')
                os.fchmod(fd,0o600);os.fsync(fd)
            finally:os.close(fd)
            os.fsync(directory)
        for suffix in ('','-wal','-shm','-journal'):
            name=base+suffix
            try:selected=os.stat(name,dir_fd=directory,follow_symlinks=False)
            except FileNotFoundError:
                if not suffix:raise ValueError('existing session history is missing')
                continue
            if not stat.S_ISREG(selected.st_mode) or selected.st_uid!=os.getuid() or selected.st_nlink!=1:
                raise ValueError('session database and sidecars must be owned regular files without hardlinks')
            fd=os.open(name,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,dir_fd=directory)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1:
                    raise ValueError('session database and sidecars must be owned regular files without hardlinks')
                if (selected.st_dev,selected.st_ino)!=(info.st_dev,info.st_ino):
                    raise ValueError('session database or sidecar changed during validation')
                if stat.S_IMODE(info.st_mode)!=0o600:
                    os.fchmod(fd,0o600);os.fsync(fd)
                if stat.S_IMODE(os.fstat(fd).st_mode)!=0o600:raise ValueError('session database or sidecar must have private mode')
                final=os.stat(name,dir_fd=directory,follow_symlinks=False)
                if not stat.S_ISREG(final.st_mode) or (final.st_dev,final.st_ino)!=(info.st_dev,info.st_ino):raise ValueError('session database or sidecar changed after validation')
            finally:os.close(fd)
    finally:os.close(directory)
