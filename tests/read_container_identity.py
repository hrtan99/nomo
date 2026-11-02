"""Inspect the owned synthetic launch without exposing its environment."""
import hashlib
import json
import subprocess
from pathlib import Path

DOCKER = '/usr/local/bin/docker'
LABEL = 'nomo.terminal.invocation'
IMAGE = 'sha256:fd69c8a6dcf422f2509e8eb14baa04639049f685a997679fbf7499b632a0ae75'
VOLUME = 'nomo-cargo-022-formal-20261101-v3'
CLI_SHA = '9e14efce344314089e5a43048c868de9f6d4376339191ee9224ed45f7b3d1144'
LOCK_SHA = 'a0cf4e743c0f7c2c141431de98d1aabbc389ad7533c92f5e4a5245b1edd3570e'
FMT = '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "nomo.terminal.invocation")}},"image":{{json .Image}},"network":{{json .HostConfig.NetworkMode}},"memory":{{.HostConfig.Memory}},"nano_cpus":{{.HostConfig.NanoCpus}},"pids":{{.HostConfig.PidsLimit}},"mounts":{{json .Mounts}}}'


def inspect_launch(root, read_root, version='0.2.2'):
    if version == '0.2.2':
        volume, cli_sha, lock_sha, lock_file = VOLUME, CLI_SHA, LOCK_SHA, 'config/etas-022-official.Cargo.lock'
    elif version == '0.2.3':
        volume, cli_sha, lock_sha, lock_file = ('nomo-cargo-023-20261102-a', '82069afbdd100254dfc2f80dfcf049f6f5e46a3b7e533b56c546821db4cbdaab',
                                                '6908d8f4c1068eef655cee2f2536a95fd7d4f573fb3da48eeefddaaccbc284de', 'config/etas-023-official.Cargo.lock')
    elif version == '0.2.4':
        volume, cli_sha, lock_sha, lock_file = ('nomo-cargo-024-candidate-20261102-a', '67802d5015aea771ab02d8e474ea18d8a83f4fdb8e06ef1a8fd9349ffadb2290',
                                                '8acf50303edf0fc9133802c80666e29095f992b23142fb16a9377d4439f0dc94', 'config/etas-024-official.Cargo.lock')
    else:
        raise ValueError('unsupported ETAS version')
    ids = subprocess.run([DOCKER, 'ps', '-q', '--filter', 'label=' + LABEL], capture_output=True, check=True, timeout=10).stdout.decode().splitlines()
    found = []
    for identifier in ids:
        item = subprocess.run([DOCKER, 'inspect', '--format', FMT, identifier], capture_output=True, check=True, timeout=10)
        value = json.loads(item.stdout)
        mounts = {entry['Destination']: entry for entry in value['mounts']}
        if mounts.get('/workspace', {}).get('Source') in (str(root), '/host_mnt' + str(root)) and mounts.get('/model-tool-fixture', {}).get('Source') in (str(read_root), '/host_mnt' + str(read_root)):
            found.append((value, mounts))
    assert len(found) == 1
    value, mounts = found[0]
    assert value['name'] == '/nomo-terminal-' + value['owner'] and len(value['owner']) == 32
    assert value['image'] == IMAGE and value['network'] == 'bridge'
    assert value['memory'] == 4294967296 and value['nano_cpus'] == 4000000000 and value['pids'] == 256
    assert all(not mounts[name]['RW'] for name in ('/workspace', '/model-tool-fixture', '/home/nomo/.cargo'))
    assert mounts['/home/nomo/.cargo']['Name'] == volume
    cli = subprocess.run([DOCKER, 'exec', value['id'], 'sha256sum', '/home/nomo/.cargo/bin/etas'], capture_output=True, check=True, timeout=10)
    actual = cli.stdout.split()[0].decode()
    assert actual == cli_sha
    assert hashlib.sha256((root / lock_file).read_bytes()).hexdigest() == lock_sha
    return {'container_id': value['id'], 'cli_sha256': actual, 'lock_sha256': lock_sha,
            'cargo_volume': volume, 'readonly_mounts_verified': True, 'resource_limits_verified': True}


def container_absent(identifier):
    value = subprocess.run([DOCKER, 'inspect', identifier], capture_output=True, timeout=10)
    return value.returncode != 0 and (b'No such object' in value.stderr or b'No such container' in value.stderr)
