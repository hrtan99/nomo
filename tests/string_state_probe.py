"""One positive old-writer/migrate/new-reader check, without model or workspace effects."""
from collections import Counter
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
from nomo_migration import relocation_manifest, relocation_package

PAYLOAD_FIELDS = {'text', 'body', 'request', 'summary', 'stdout', 'stderr', 'before', 'after',
                  'pending', 'history_version', 'parent_version', 'parent_digest', 'original'}


def stored_rows(database):
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
        return {(region, path, key): value(json.loads(raw))
                for region, path, key, raw in db.execute(
                    'SELECT region,path,key_json,value_json FROM memory_entries')}


def leaves(rows):
    numeric, payload, binary = Counter(), Counter(), Counter()

    def visit(item, field=None):
        if isinstance(item, bool):
            numeric[('bool', item)] += 1
        elif isinstance(item, int):
            numeric[('integer', item)] += 1
        elif isinstance(item, bytes):
            binary[item] += 1
        elif isinstance(item, str) and field in PAYLOAD_FIELDS:
            payload[(field, item)] += 1
        elif isinstance(item, list):
            for child in item:
                visit(child, field)
        elif isinstance(item, dict):
            for name, child in item.items():
                visit(child, name)

    for row in rows.values():
        visit(row)
    return numeric, payload, binary


def protocols(output):
    return [line for line in output.splitlines() if line.startswith('[PROTOCOL] ')]


def run(source_format='native-string-state'):
    kind = 'baseline' if source_format == 'native-string-state' else 'historical'
    evidence = Path(tempfile.mkdtemp(prefix='nomo-string-state-' + kind + '-')).resolve()
    package = evidence / 'seed'
    relocation_package(ROOT, package, 'export.es', historical=True, source_format=source_format)
    shutil.copyfile(ROOT / ('tests/fixtures/string_state/' + kind + '_seed.es'), package / 'src/app/main.es')
    old = evidence / 'old'
    old.mkdir()
    relocation_manifest(package, '/state-proof/old/conversations.sqlite3')
    before_file = old / 'edits/before'
    before_file.parent.mkdir()
    before_file.write_bytes('鹈鹕\0\n'.encode())
    before_file.chmod(0o640)
    consumer = evidence / 'consumer'
    shutil.copytree(ROOT / 'src', consumer / 'src')
    (consumer / 'src/app').mkdir()
    shutil.copyfile(ROOT / 'tests/fixtures/string_state/consume.es', consumer / 'src/app/main.es')
    relocation_manifest(consumer, '/state-proof/migrated/state/conversations.sqlite3')
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {'volumes': [
        {'type': 'bind', 'source': str(evidence), 'target': '/state-proof'}]}},
        'volumes': {'cargo-cache': {'external': True}}}))
    command = ['docker', 'compose', '-p', 'nomo-string-state-proof', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-02413-official-compose.yaml',
                 'config/local-tryout-compose.yaml', 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['-f', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', '--no-config', '--cache', 'off', 'run']
    environment = dict(os.environ, NOMO_NATIVE_UID=str(os.getuid()), NOMO_NATIVE_GID=str(os.getgid()))

    def execute(label, argv):
        print(label + ' ' + str(evidence), flush=True)
        result = subprocess.run(argv, cwd=ROOT, env=environment, capture_output=True, text=True, timeout=600)
        (evidence / (label + '.stdout')).write_text(result.stdout)
        (evidence / (label + '.stderr')).write_text(result.stderr)
        assert result.returncode == 0, label + ': ' + result.stderr + result.stdout
        return result

    execute('seed', command + ['/state-proof/seed', '--allow-effects',
                                '--trace-out', '/state-proof/seed.trace.json'])
    execute('migrate', [str(ROOT / 'scripts/nomo-migrate-native'), '--from', source_format,
                        str(old / 'conversations.sqlite3'), str(evidence / 'migrated')])
    execute('consume', command + ['/state-proof/consumer', '--allow-effects',
                                  '--trace-out', '/state-proof/consume.trace.json'])
    return verify(evidence, source_format)


def verify(evidence, source_format):
    """Verify retained producer/migration/consumer evidence without replaying it."""
    database = evidence / 'old/conversations.sqlite3'
    before_file = evidence / 'old/edits/before'
    destination = evidence / 'migrated'
    report = json.loads((destination / 'migration.json').read_text())
    assert report['status'] == 'completed' and report['rows'] == 43
    assert report['source_format'] == source_format
    assert hashlib.sha256(database.read_bytes()).hexdigest() == report['source_database_sha256']
    expected = stored_rows(database)
    assert len(expected) == 43
    assert stored_rows(destination / 'input/legacy-source.sqlite3') == expected
    actual = stored_rows(destination / 'state/conversations.sqlite3')
    assert actual.keys() == expected.keys()
    numbers, payload, binary = leaves(expected)
    new_numbers, new_payload, new_binary = leaves(actual)
    # One "37" failure exit string becomes the numeric payload Failed(37).
    assert new_numbers == numbers + Counter({('integer', 37): 1})
    assert new_payload == payload and new_binary == binary
    seed = (evidence / 'seed.stdout').read_text()
    checked = (evidence / 'consume.stdout').read_text()
    assert 'PASS typed reads of 43 stores' in checked
    assert len(protocols(seed)) == 5 and protocols(checked) == protocols(seed)
    copied = destination / 'state/edits/before'
    assert copied.read_bytes() == before_file.read_bytes()
    assert copied.stat().st_mode == before_file.stat().st_mode
    assert copied.stat().st_mtime_ns == before_file.stat().st_mtime_ns
    with sqlite3.connect(database) as original, sqlite3.connect(destination / 'input/legacy-source.sqlite3') as backup:
        assert original.execute('SELECT * FROM memory_receipts').fetchall() == backup.execute('SELECT * FROM memory_receipts').fetchall()
    result = {'status': 'passed', 'source_format': source_format, 'evidence': str(evidence),
              'stores': 43, 'typed_consumer_checks': 33, 'protocol_goldens': 5,
              'numeric_and_boolean_leaves_preserved': True, 'failed_exit_code_now_i32': 37,
              'i64_above_json_exact_range': 9007199254740993,
              'payload_and_binary_leaves_preserved': True, 'source_unchanged': True,
              'old_receipts_retained': True, 'filesystem_objects_preserved': True,
              'real_model_calls': 0, 'edit_command_or_recovery_replay': False}
    (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS ' + json.dumps(result), flush=True)
    return result


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) > 1 else 'native-string-state')
