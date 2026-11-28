#!/usr/bin/env python3
"""Shared test-only observation of historical SQL values; no CLI or Host builder."""
from contextlib import closing
import hashlib
import json
import re
import sqlite3

INITIALIZED = 'INITIALIZED demo namespace; one save permitted\n'
BINDING = 'ordinary-demo-binding-not-authority'
DB_NAMES = ('memory.sqlite3', 'session.sqlite3')


def accepted_compose_stderr(stderr, root):
    """Accept only the exact existing-volume notice; retain raw stderr in evidence."""
    names = re.findall(r'^  cargo-cache:\n    name: ([a-z0-9-]+)$',
                       (root / 'compose.yaml').read_text(), re.M)
    assert len(names) == 1, 'normal cache volume must be explicit'
    notice = ('volume "' + names[0] + '" already exists but was not created by Docker Compose. '
              'Use `external: true` to use an existing volume')
    pattern = r'time="[^"\n]+" level=warning msg=' + re.escape(json.dumps(notice))
    return all(re.fullmatch(pattern, line) for line in stderr.splitlines())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def typed(value):
    if value is None:
        return {'type': 'null'}
    if isinstance(value, bytes):
        return {'type': 'blob', 'value': value.hex()}
    return {'type': type(value).__name__, 'value': value}


def inspect_store(directory):
    """Read-only test observation; canonical logical schema/rows, not file bytes."""
    logical, raw = {}, {}
    for name in DB_NAMES:
        path = directory / name
        if not path.exists():
            continue
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as connection:
            schema = connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
            rows = {}
            for (table,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
                quoted = '"' + table.replace('"', '""') + '"'
                values = [[typed(value) for value in row] for row in connection.execute('SELECT * FROM ' + quoted)]
                rows[table] = sorted(values, key=lambda row: json.dumps(row, sort_keys=True))
            logical[name] = {'schema': schema, 'rows': rows,
                             'user_version': connection.execute('PRAGMA user_version').fetchone()[0],
                             'application_id': connection.execute('PRAGMA application_id').fetchone()[0]}
            raw[name] = '\n'.join(connection.iterdump())
    return logical, raw


def untag(value):
    kind = value['kind']
    if kind == 'record':
        return {field['name']: untag(field['value']) for field in value['fields']}
    if kind in ('array', 'list'):
        return [untag(item) for item in value['items']]
    if kind in ('int', 'uint'):
        return int(value['value'])
    if kind in ('string', 'bool', 'json'):
        return value['value']
    raise AssertionError('unexpected SQLite test-oracle value: ' + kind)


def metadata(directory):
    with closing(sqlite3.connect((directory / 'memory.sqlite3').as_uri() + '?mode=ro', uri=True)) as connection:
        values = [untag(json.loads(row[0])) for row in connection.execute('SELECT value_json FROM memory_entries')]
    with closing(sqlite3.connect((directory / 'session.sqlite3').as_uri() + '?mode=ro', uri=True)) as connection:
        count = connection.execute('SELECT COUNT(*) FROM session_messages').fetchone()[0]
    return values, count


def expected(session, events, spent, steps, budget, pending=False):
    records = [dict(zip(('role', 'kind', 'name', 'text'), event)) for event in events]
    references = [{'operation': '', 'phase': ''} for _ in records]
    operations = []
    for index, event in enumerate(records):
        if event['role'] == 'model':
            references[index] = {'operation': 'stub-request-' + str(index), 'phase': 'request'}
            operations.append({'id': references[index]['operation'], 'status': 'pending' if pending else 'completed',
                               'attempts': 0, 'tokens': 0, 'scan_bytes': 0})
        elif event['role'] == 'tool':
            references[index] = {'operation': operations[-1]['id'], 'phase': 'outcome'}
    caps = {'steps': budget, 'turn_steps': steps, 'attempts': 0, 'tokens': 0, 'scan_bytes': 0}
    return {'session_id': session, 'generation': 0, 'mode': 'stub', 'binding': BINDING,
            'disposition': 'recovery-required' if pending else 'validated',
            'history': {'events': records, 'characters': sum(len(e['name']) + len(e['text']) for e in records),
                        'spent': spent, 'stopped': pending or spent >= budget},
            'references': references, 'operations': operations, 'original_caps': dict(caps), 'caps': caps,
            'ledger': {'attempts': 0, 'tokens': 0, 'scan_bytes': 0, 'step_unit': 'steps', 'attempt_unit': 'attempts',
                       'token_unit': 'total-input-output-tokens', 'scan_unit': 'bytes'}}
