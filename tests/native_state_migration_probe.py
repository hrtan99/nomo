"""Migrate one actual format-3 native database, then compare every stored fact and reopen it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

from native_memory_value import value as current_value

ROOT = Path(__file__).resolve().parents[1]


def old_value(value):
    kind = value['kind']
    if kind in ('int', 'uint'):
        return int(value['value'])
    if kind == 'bytes':
        return bytes(value['value'])
    if kind in ('string', 'bool'):
        return value['value']
    if kind == 'record':
        return {item['name']: old_value(item['value']) for item in value['fields']}
    if kind == 'list':
        return [old_value(item) for item in value['items']]
    if kind == 'variant':
        return {'name': value['name'], 'fields': [old_value(item) for item in value['fields']]}
    raise AssertionError('unexpected original fixture kind: ' + kind)


def rows(path, decode):
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        return {(region, store, decode(json.loads(key))): decode(json.loads(value))
                for region, store, key, value in db.execute('SELECT region,path,key_json,value_json FROM memory_entries')}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(path):
    trace = json.loads(path.read_text())
    assert trace['outcome']['kind'] == 'completed' and trace['termination']['local_work_settled']
    starts = [event for event in trace['events'] if event['kind'] == 'host_request_started']
    ends = [event for event in trace['events'] if event['kind'] == 'host_request_finished']
    assert len(starts) == len(ends) and {event['id'] for event in starts} == {event['id'] for event in ends}
    assert all(event['outcome']['kind'] == 'succeeded' for event in ends)
    assert not any(event.get('request_kind') == 'model' or event.get('qualified_action', '').startswith('Command.') for event in starts)
    return len(starts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='actual retained native 0.13.5 database')
    options = parser.parse_args()
    source = options.source.resolve()
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-state-migration-')).resolve()
    destination = evidence / 'migrated'
    before = digest(source)
    expected = rows(source, old_value)
    print('EVIDENCE ' + str(evidence), flush=True)
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/nomo-migrate-native'), str(source), str(destination)],
                            cwd=ROOT, capture_output=True, text=True)
    (evidence / 'stdout.txt').write_text(result.stdout)
    (evidence / 'stderr.txt').write_text(result.stderr)
    report = {'status': 'observed', 'migration_exit': result.returncode,
              'source_before': before, 'source_after': digest(source), 'original_rows': len(expected)}
    (evidence / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    assert result.returncode == 0, result.stdout + result.stderr
    assert digest(source) == before
    migrated = destination / 'state/conversations.sqlite3'
    assert rows(migrated, current_value) == expected, 'migration changed stored keys or values'
    receipt = json.loads((destination / 'migration.json').read_text())
    assert receipt['status'] == 'completed' and receipt['rows'] == len(expected)
    migration_requests = audit(destination / 'trace/trace.json')
    selected = next(value for (region, store, _), value in expected.items()
                    if region == 'nomo-native-conversations-v1' and store == '["Sessions"]')
    environment = dict(os.environ, MINIMAX_API_KEY='synthetic-unused', NOMO_NATIVE_STATE=str(destination / 'state'),
                       NOMO_NATIVE_TRACE_ROOT=str(evidence / 'restore-traces'))
    command = [str(ROOT / 'scripts/nomo-native'), selected['workspace'], '--id', selected['id']]
    restored = subprocess.run(command + ['--status'], cwd=ROOT, env=environment, capture_output=True, text=True)
    (evidence / 'status.txt').write_text(restored.stdout + restored.stderr)
    assert restored.returncode == 0, restored.stdout + restored.stderr
    actual = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in restored.stdout.splitlines() if '[STATUS ] {' in line))
    assert actual == selected
    history = subprocess.run(command + ['--history'], cwd=ROOT, env=environment, capture_output=True, text=True)
    (evidence / 'history.txt').write_text(history.stdout + history.stderr)
    assert history.returncode == 0, history.stdout + history.stderr
    complete_events = 0
    for (region, store, key), value in expected.items():
        if region != 'nomo-native-conversations-v1' or store != '["Events"]' or not key.startswith(selected['id'] + ':') or not value['complete']:
            continue
        text = ''.join(expected[(region, '["Chunks"]', key + ':' + str(part))] for part in range(value['chunks']))
        marker = '[' + value['role'] + '/' + value['name'] + ' #' + key.split(':')[-1] + '] '
        assert marker + text in history.stdout
        complete_events += 1
    restore_requests = sum(audit(path) for path in (evidence / 'restore-traces').glob('run-*/trace.json'))
    assert digest(source) == before
    report.update(status='passed', unchanged_original=True, exact_all_row_comparison=True,
                  migrated_store_paths=len({key[:2] for key in expected}), complete_events=complete_events,
                  migration_host_requests=migration_requests, restore_host_requests=restore_requests,
                  model_requests=0, command_actions=0,
                  qualification='One actual old native image, exact all-key/all-value comparison and fresh status/history. '
                                'No new adverse cases. Store kinds absent from this source retain source-check-only scope; '
                                'shipping Python archive/legacy-session migration is separate.')
    (evidence / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print('PASS exact native state migration and fresh-process history: ' + str(evidence))


if __name__ == '__main__':
    main()
