#!/usr/bin/env python3
"""Actual SQLite commit/response-loss tests; no storage policy lives in this helper."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

from session_state_probe import snapshot
from session_store_probe import expected, fixture_source, materialize, plain

GRAPH = Path('/validation')
ROOT = Path(__file__).resolve().parent.parent
HARNESS = GRAPH / 'target/debug/nomo-session-store-host-faults'
FAULTS = ('pending', 'append', 'publish', 'missing-history', 'conflict',
          'stale-pending', 'publish-readback', 'reload-changed')
MARKER = 'AFTER_STORE_CALL\n'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def untag(value):
    """Test oracle only: inspect upstream's SQLite tagged values, never reload product state."""
    kind = value['kind']
    if kind == 'record':
        return {field['name']: untag(field['value']) for field in value['fields']}
    if kind in ('array', 'list'):
        return [untag(item) for item in value['items']]
    if kind in ('int', 'uint'):
        return int(value['value'])
    if kind in ('string', 'bool', 'json'):
        return value['value']
    raise AssertionError('unexpected test-oracle value: ' + kind)


def contents(database):
    """Independent read-only database observation, including receipts and versions."""
    result = {}
    for name in ('memory.sqlite3', 'session.sqlite3'):
        with sqlite3.connect('file:' + str(database / name) + '?mode=ro', uri=True) as connection:
            result[name] = '\n'.join(connection.iterdump())
    return result


def stored(database):
    with sqlite3.connect('file:' + str(database / 'memory.sqlite3') + '?mode=ro', uri=True) as connection:
        rows = connection.execute('SELECT value_json,version FROM memory_entries').fetchall()
        assert len(rows) == 1, rows
    with sqlite3.connect('file:' + str(database / 'session.sqlite3') + '?mode=ro', uri=True) as connection:
        count = connection.execute('SELECT COUNT(*) FROM session_messages').fetchone()[0]
    return untag(json.loads(rows[0][0])), rows[0][1], count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fault', action='append', choices=FAULTS)
    parser.add_argument('--mode', action='append', choices=('stub', 'text-model', 'scripted-read'))
    options = parser.parse_args()
    faults = options.fault or list(FAULTS)
    modes = options.mode or ['stub', 'text-model', 'scripted-read']
    identity = json.loads((GRAPH / 'host-faults-identity.json').read_text())
    assert digest(HARNESS) == identity['fixture_binary_sha256']
    assert digest(GRAPH / 'host-faults/Cargo.lock') == identity['fixture_lock_sha256']
    fixture_root = ROOT / 'tests/fixtures/session_store/host_faults'
    assert {name: digest(fixture_root / name) for name in identity['fixture_source_sha256']} == identity['fixture_source_sha256']
    project = Path(tempfile.mkdtemp(prefix='session-store-actual-faults-', dir=GRAPH))
    print('EVIDENCE ' + str(project), flush=True)
    source = materialize(project)
    results = []
    generated = project / 'generated'
    generated.mkdir()

    def retain(data, suffix):
        checksum = hashlib.sha256(data).hexdigest()
        path = generated / (checksum + suffix)
        if path.exists():
            assert path.read_bytes() == data, 'immutable evidence collision'
        else:
            path.write_bytes(data)
        return {'path': str(path.relative_to(project)), 'sha256': checksum}

    (project / 'host-identity.json').write_text(json.dumps(identity, indent=2))
    retained_harness = {name: retain((fixture_root / name).read_bytes(), '.host-source')
                        for name in identity['fixture_source_sha256']}
    retained_manifest = retain((project / 'etas.toml').read_bytes(), '.toml')
    retained_lock = retain((GRAPH / 'host-faults/Cargo.lock').read_bytes(), '.Cargo.lock')
    (project / 'harness-sources.json').write_text(json.dumps(retained_harness, indent=2))
    retained_drivers = {name: retain((ROOT / 'tests' / name).read_bytes(), '.driver.py')
                        for name in ('session_store_fault_probe.py', 'session_store_probe.py', 'session_state_probe.py')}
    (project / 'driver-sources.json').write_text(json.dumps(retained_drivers, indent=2))
    copied = {str(path.relative_to(project)): digest(path) for path in (project / 'src').rglob('*.es')}
    (project / 'product-sources.json').write_text(json.dumps(copied, indent=2))

    def invoke(database, fault, action, session_id, save_id, payload):
        command = [str(HARNESS), str(project / 'src'), 'app.main', 'main', str(database), fault,
                   action, session_id, save_id, payload]
        retained_entry = retain(source.read_bytes(), '.es')
        # This embedder has no CLI/runtime profile file. Retain its effective,
        # test-only configuration instead of claiming that it loaded one.
        profile = {
            'profile_kind': 'effective embedded test Host configuration; no CLI profile loaded',
            'run_options': 'RunOptions::default()', 'entry_module': 'app.main', 'entry_flow': 'main',
            'source_root': str(project / 'src'), 'fixture_manifest_consumed': False,
            'memory_sqlite': str(database / 'memory.sqlite3'),
            'session_sqlite': str(database / 'session.sqlite3'), 'fault': fault,
            'console': 'captured writes only', 'other_host_services': 'denied',
            'binary_sha256': identity['fixture_binary_sha256'],
        }
        retained_profile = retain(json.dumps(profile, sort_keys=True, indent=2).encode(), '.profile.json')
        process = subprocess.run(command, text=True, capture_output=True, timeout=45,
                                 env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
        item = {'command': command, 'exit': process.returncode,
                'stdout': process.stdout, 'stderr': process.stderr, 'source_sha256': digest(source),
                'entry_source': retained_entry, 'fixture_manifest': retained_manifest,
                'effective_host_profile': retained_profile, 'harness_lock': retained_lock}
        results.append(item)
        (project / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        assert process.returncode == 0, item
        result = json.loads(process.stdout)
        assert result['denied_services'] == 0 and result['writes_after_fault'] == 0, result
        assert result['denied_writes'] == 0, result
        result['after_store_marker'] = result['stdout'].startswith(MARKER)
        result['application_stdout'] = result['stdout'].removeprefix(MARKER)
        return result

    completed = []
    for mode in modes:
        source.write_text(fixture_source(mode).replace('    match result {',
                          '    println("AFTER_STORE_CALL");\n    match result {'))
        shutil.copyfile(source, project / (mode + '-fixture.es'))
        for fault in faults:
            database = project / (mode + '-' + fault)
            database.mkdir()
            session_id, save_id = mode + '-' + fault, 'save1'
            bodies = ['duplicate', '', '雪😀"\\\n\r\t\x00duplicate']
            payload = json.dumps(['nomo-session-bundle-v1', session_id, save_id, *bodies], ensure_ascii=False)
            setup = invoke(database, 'none', 'setup', session_id, save_id, payload)
            assert setup['diagnostics'] == [] and setup['stdout'] == 'SETUP_EMPTY\n', setup
            assert setup['memory_mutations'] == 0 and setup['session_appends'] == 0, setup
            saved = invoke(database, 'none' if fault in ('missing-history', 'reload-changed') else fault,
                           'save', session_id, save_id, payload)
            if fault in ('missing-history', 'reload-changed'):
                assert not saved['fault_fired'] and saved['diagnostics'] == [], saved
                assert saved['after_store_marker'], saved
                assert json.loads(saved['application_stdout']) == expected(mode, session_id, bodies), saved
            elif fault in ('pending', 'append', 'publish'):
                assert saved['fault_fired'], saved
                losses = [event for event in saved['trace'] if event.get('acknowledgement_dropped')]
                assert len(losses) == 1 and losses[0]['actual_sqlite_commit'], losses
                assert saved['memory_mutations'] == (2 if fault == 'publish' else 1), saved
                assert saved['session_appends'] == (0 if fault == 'pending' else 1), saved
                assert saved['session_resolves'] == (0 if fault == 'pending' else 1), saved
                assert any(event.get('kind') == 'storage_write'
                           and event['evidence']['status']['kind'] == 'unknown'
                           for event in saved['events']), saved
                if fault == 'pending':
                    assert saved['after_store_marker'] and saved['diagnostics'] == [], saved
                    assert saved['application_stdout'] == 'REFUSED metadata commit unknown; no retry\n', saved
                    assert saved['post_fault_reads'] == 0, saved
                else:
                    assert not saved['after_store_marker'] and saved['stdout'] == '', saved
                    assert saved['post_fault_reads'] == saved['post_fault_console'] == 0, saved
            else:
                assert saved['fault_fired'] and saved['fixture_mutations'] == 1, saved
                assert saved['memory_mutations'] == (1 if fault == 'stale-pending' else 2), saved
                assert saved['session_appends'] == saved['session_resolves'] == 1, saved
                if fault == 'conflict':
                    assert any(event.get('actual_sqlite_cas_conflict') for event in saved['trace']), saved
                    assert not any(event.get('ordinal') == 2 and event['actual_sqlite_commit']
                                   for event in saved['trace']), saved
                    assert saved['stdout'] == '' and not saved['after_store_marker'], saved
                elif fault == 'stale-pending':
                    assert saved['application_stdout'] == 'REFUSED pending metadata changed\n', saved
                else:
                    assert saved['application_stdout'] == 'REFUSED published metadata readback mismatch\n', saved

            row, version, message_count = stored(database)
            wanted = plain(snapshot(mode))
            wanted['session_id'] = session_id
            wanted['history']['characters'] = expected(mode, session_id, bodies)['history']['characters']
            for event in wanted['history']['events']:
                event['text'] = ''
            assert row['snapshot'] == wanted, (row, wanted)
            published = fault in ('publish', 'missing-history', 'publish-readback', 'reload-changed')
            assert row['phase'] == ('published' if published else 'pending'), row
            assert row['save_id'] == ('competing-save-marker' if fault == 'publish-readback' else save_id), row
            assert row['format'] == 1, row
            assert version == (3 if fault == 'publish-readback' else 1 if fault in ('pending', 'append') else 2), version
            assert message_count == (0 if fault == 'pending' else 1), message_count

            if fault == 'missing-history':
                # Test-only fault in a dedicated disposable database, not a product adapter.
                with sqlite3.connect(database / 'session.sqlite3') as connection:
                    connection.execute('DELETE FROM session_messages')
                assert stored(database)[2] == 0

            before = contents(database)
            if fault == 'reload-changed':
                changed = invoke(database, 'reload-changed', 'load', session_id, save_id, payload)
                assert changed['fault_fired'] and changed['fixture_mutations'] == 1, changed
                assert changed['memory_mutations'] == changed['session_appends'] == changed['session_resolves'] == 0, changed
                assert changed['application_stdout'] == 'REFUSED metadata changed during reload\n', changed
                observed, updated_version, updated_messages = stored(database)
                assert observed == row and updated_version == version + 1 and updated_messages == 1
                before = contents(database)
            loaded = invoke(database, 'read-only', 'load', session_id, save_id, payload)
            assert loaded['diagnostics'] == [], loaded
            assert loaded['memory_mutations'] == loaded['session_appends'] == loaded['session_resolves'] == 0, loaded
            assert contents(database) == before, 'reload changed logical store contents'
            assert loaded['after_store_marker'], loaded
            if fault in ('publish', 'reload-changed'):
                assert json.loads(loaded['application_stdout']) == expected(mode, session_id, bodies), loaded
            elif fault == 'missing-history':
                assert loaded['application_stdout'] == 'REFUSED expected exactly one complete bundle\n', loaded
            elif fault == 'publish-readback':
                assert loaded['application_stdout'] == 'REFUSED metadata identity mismatch\n', loaded
            else:
                assert loaded['application_stdout'] == 'REFUSED pending save; recovery required; no retry\n', loaded
            completed.append(mode + ':' + fault)
            (project / 'summary.json').write_text(json.dumps({
                'evidence_mode': 'actual SQLite commits followed by dropped Host acknowledgements; separate process reload',
                'completed': completed, 'source_checksums': copied,
                'test_sources': retained_drivers,
                'selected_modes': modes, 'selected_faults': faults,
                'injected_missing_history': 'test-only SQL deletion, not acknowledgement loss',
                'competing_writer': 'real SQLite version-matched mutation; fixture_mutations are not product calls',
                'interrupted_save_mapping': {
                    '1 before append': 'pending acknowledgement loss',
                    '2 append committed acknowledgement missing': 'append acknowledgement loss',
                    '3 append visible metadata unpublished': 'real publication CAS conflict and stale-pending read',
                    '4 publication uncertain': 'publish acknowledgement loss and exact separate-process readback',
                    '5 extra or partial history': 'missing-history deletion; extra/partial-bundle cases in main storage probe',
                    '6 recorded history not verifiable': 'missing-history and published marker mismatch',
                },
                'read_only': 'no mutating Host calls and identical complete logical SQLite dumps; not an immutable SQLite connection',
            }, indent=2))
            print('PASS actual_storage_' + mode + '_' + fault, flush=True)
    actual_losses = sum(case.split(':')[1] in ('pending', 'append', 'publish') for case in completed)
    print('PASS ' + str(actual_losses) + ' actual committed acknowledgement losses and '
          + str(len(completed) - actual_losses) + ' real conflict/readback/history cases', flush=True)


if __name__ == '__main__':
    main()
