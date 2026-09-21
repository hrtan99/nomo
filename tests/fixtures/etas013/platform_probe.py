#!/usr/bin/env python3
"""Read-only deployment preflight. ABI availability is not a confinement pass."""
import ctypes
import hashlib
import json
import platform
import fcntl
import socket
import struct
from pathlib import Path


def main():
    fields = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines()
                  if ':' in line)
    assert int(fields['CapEff'].strip(), 16) == 0
    assert fields['NoNewPrivs'].strip() == '1'
    assert fields['Seccomp'].strip() == '2'
    assert platform.machine() == 'aarch64'
    mounts = [line.split() for line in Path('/proc/mounts').read_text().splitlines()]
    for target in ['/', '/workspace', '/home/nomo/.cargo']:
        assert any(row[1] == target and 'ro' in row[3].split(',') for row in mounts), target
    binary = Path('/home/nomo/.cargo/bin/etas')
    accepted = hashlib.sha256(binary.read_bytes()).hexdigest()
    assert accepted == '0dead4ce2fd435a2c711629a7197bc0da041ed7ad2ff241f2f4f9b3ef17fbaad'
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # Linux aarch64: LANDLOCK_CREATE_RULESET_VERSION queries only; no policy mutation.
    abi = libc.syscall(ctypes.c_long(444), ctypes.c_void_p(), ctypes.c_size_t(0),
                       ctypes.c_uint(1))
    error = ctypes.get_errno() if abi == -1 else 0
    interfaces = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        for _, name in socket.if_nameindex():
            response = fcntl.ioctl(sock, 0x8913, struct.pack('256s', name.encode()))
            interfaces[name] = struct.unpack_from('H', response, 16)[0]
    assert [name for name, flags in interfaces.items() if flags & 1] == ['lo']
    assert len(Path('/proc/net/route').read_text().splitlines()) == 1
    result = {'kernel': platform.release(), 'machine': platform.machine(),
              'uid': fields['Uid'].strip(), 'cap_eff': fields['CapEff'].strip(),
              'seccomp': fields['Seccomp'].strip(), 'no_new_privs': fields['NoNewPrivs'].strip(),
              'landlock_abi': abi, 'landlock_errno': error, 'accepted_binary_sha256': accepted,
              'command_positive': 'NOT_RUN' if abi >= 5 else 'BLOCKED_PLATFORM',
              'mounts': [row for row in mounts if row[1] in
                         ['/', '/workspace', '/home/nomo/.cargo', '/validation', '/tmp']],
              'network_interface_flags': interfaces}
    Path('/validation/platform.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
