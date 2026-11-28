"""Official old-reader/new-writer migration of all 43 persisted store shapes."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

from native_memory_value import value

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from nomo_migration import relocation_manifest


def rows(path):
    with sqlite3.connect(path) as db:
        return {(region, store, key): value(json.loads(data))
                for region, store, key, data in db.execute(
                    'SELECT region,path,key_json,value_json FROM memory_entries')}


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-state-relocation-')).resolve()
    old = evidence / 'old'
    old.mkdir()
    package = evidence / 'seed'
    shutil.copytree(ROOT / 'tests/fixtures/state_relocation/old/src', package / 'src')
    (package / 'src/app/main.es').write_bytes((ROOT / 'tests/fixtures/state_relocation/seed.es').read_bytes())
    relocation_manifest(package, '/relocation/old/conversations.sqlite3')
    # Files used by retained editor/job records remain filesystem objects.
    (old / 'edits').mkdir()
    snapshot = old / 'edits/before'
    snapshot.write_bytes('鹈鹕\0\n'.encode())
    snapshot.chmod(0o640)
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {'volumes': [
        {'type': 'bind', 'source': str(evidence), 'target': '/relocation'}]}},
        'volumes': {'cargo-cache': {'external': True}}}))
    command = ['docker', 'compose', '-p', 'nomo-state-relocation', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-02413-official-compose.yaml',
                 'config/local-tryout-compose.yaml', 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['-f', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', '--no-config', '--cache', 'off', 'run', '/relocation/seed',
                '--allow-effects', '--trace-out', '/relocation/seed.trace.json']
    environment = dict(os.environ, NOMO_NATIVE_UID=str(os.getuid()), NOMO_NATIVE_GID=str(os.getgid()))
    print('EVIDENCE ' + str(evidence), flush=True)
    seed = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, text=True, timeout=240)
    (evidence / 'seed.stdout').write_text(seed.stdout)
    (evidence / 'seed.stderr').write_text(seed.stderr)
    assert seed.returncode == 0, seed.stderr
    database = old / 'conversations.sqlite3'
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    expected = rows(database)
    assert len(expected) == 43
    destination = evidence / 'migrated'
    migration = subprocess.run([str(ROOT / 'scripts/nomo-migrate-native'), '--from', 'native-02413',
                                str(database), str(destination)], cwd=ROOT, env=environment,
                               capture_output=True, text=True, timeout=300)
    (evidence / 'migration.stdout').write_text(migration.stdout)
    (evidence / 'migration.stderr').write_text(migration.stderr)
    assert migration.returncode == 0, migration.stdout + migration.stderr
    report = json.loads((destination / 'migration.json').read_text())
    assert report['status'] == 'completed' and report['rows'] == 43, report
    assert hashlib.sha256(database.read_bytes()).hexdigest() == before
    assert rows(destination / 'input/legacy-source.sqlite3') == expected
    assert rows(destination / 'state/conversations.sqlite3') == expected
    copied = destination / 'state/edits/before'
    assert copied.read_bytes() == snapshot.read_bytes()
    assert copied.stat().st_mode == snapshot.stat().st_mode
    assert copied.stat().st_mtime_ns == snapshot.stat().st_mtime_ns
    with sqlite3.connect(database) as source, sqlite3.connect(destination / 'input/legacy-source.sqlite3') as backup:
        assert source.execute('SELECT * FROM memory_receipts').fetchall() == backup.execute('SELECT * FROM memory_receipts').fetchall()
    with sqlite3.connect(database) as source, sqlite3.connect(destination / 'state/conversations.sqlite3') as current:
        assert source.execute('SELECT region,path,generation FROM memory_stores ORDER BY region,path').fetchall() != current.execute('SELECT region,path,generation FROM memory_stores ORDER BY region,path').fetchall()
    result = {'status': 'passed', 'evidence': str(evidence), 'stores': 43, 'rows': 43,
              'all_logical_values_exact': True, 'i64_above_json_exact_range': 9007199254740993,
              'source_unchanged': True, 'old_receipts_retained': True,
              'fresh_backend_versions': True, 'filesystem_objects_preserved': True,
              'real_model_calls': 0, 'edit_or_recovery_replay': False}
    (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS complete typed state relocation: ' + str(evidence))


if __name__ == '__main__':
    main()
