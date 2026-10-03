#!/usr/bin/env python3
"""SESSION-CLI-001B Host-boundary checks; all initialization policy executes in Etas."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
GRAPH = Path(os.environ.get('SESSION_STORE_GRAPH', '/validation'))
EVIDENCE = Path(os.environ.get('NOMO_TEST_EVIDENCE', '/tmp'))
HOST = GRAPH / 'target/debug/nomo-session-store-host-faults'
CLI = Path(os.environ.get('ETAS', str(GRAPH / 'target/debug/etas')))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def logical(database):
    state = {}
    for name in ('memory.sqlite3', 'session.sqlite3'):
        connection = sqlite3.connect('file:' + str(database / name) + '?mode=ro', uri=True)
        try:
            schema = connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
            tables = {}
            for kind, table, _, _ in schema:
                if kind == 'table':
                    rows = connection.execute('SELECT * FROM "' + table.replace('"', '""') + '"').fetchall()
                    tables[table] = sorted(map(repr, rows))
            state[name] = {'schema': schema, 'tables': tables}
        finally:
            connection.close()
    return state


def claim_state(database):
    def untag(value):
        if value['kind'] == 'record':
            return {item['name']: untag(item['value']) for item in value['fields']}
        if value['kind'] in ('int', 'uint'):
            return int(value['value'])
        return value['value']
    connection = sqlite3.connect('file:' + str(database / 'memory.sqlite3') + '?mode=ro', uri=True)
    try:
        rows = connection.execute('SELECT value_json,version FROM memory_entries').fetchall()
    finally:
        connection.close()
    assert len(rows) == 1, rows
    return untag(json.loads(rows[0][0])), rows[0][1]


def main():
    host_identity = json.loads((GRAPH / 'host-faults-identity.json').read_text())
    cli_identity = json.loads((GRAPH / 'binary.json').read_text())
    assert digest(HOST) == host_identity['fixture_binary_sha256']
    assert digest(CLI) == cli_identity['sha256']
    assert 'NOMO_SESSION_DEMO_HOST_IDENTITY' in os.environ, 'build tests/fixtures/session_demo/build_host.py first'
    demo_identity_path = Path(os.environ['NOMO_SESSION_DEMO_HOST_IDENTITY'])
    demo_identity = json.loads(demo_identity_path.read_text())
    assert demo_identity['base_identity'] == host_identity
    assert demo_identity['added_fault'] == 'publish-before-dispatch'
    assert demo_identity['recipe_sha256'] == digest(ROOT / 'tests/fixtures/session_demo/build_host.py')
    assert demo_identity['bootstrap_sha256'] == digest(ROOT / 'scripts/etas-0013-cli-bootstrap.py')
    assert demo_identity['verified_cli'] == cli_identity
    assert digest(demo_identity_path.parent / 'normal_bootstrap.py') == demo_identity['bootstrap_sha256']
    cache_mount = next(line for line in Path('/proc/self/mountinfo').read_text().splitlines()
                       if line.split()[4] == '/home/nomo/.cargo')
    assert 'ro' in cache_mount.split()[5].split(','), 'normal Cargo cache must be mounted read-only'
    host = Path(demo_identity['fixture_binary'])
    assert digest(host) == demo_identity['fixture_binary_sha256']
    fixture = Path(demo_identity['fixture_source_root'])
    assert digest(fixture / 'Cargo.lock') == demo_identity['fixture_lock_sha256'] == host_identity['fixture_lock_sha256']
    assert {name: digest(fixture / name) for name in demo_identity['fixture_source_sha256']} == demo_identity['fixture_source_sha256']
    assert digest(demo_identity_path.parent / 'metadata.json') == demo_identity['metadata_sha256']
    assert digest(demo_identity_path.parent / 'origins.json') == demo_identity['origins_sha256']
    assert EVIDENCE.is_dir(), 'explicit existing evidence directory required'
    assert not EVIDENCE.resolve().is_relative_to(GRAPH.resolve()), 'evidence must not mutate the retained toolchain graph'
    assert digest(GRAPH / 'host-faults/Cargo.lock') == host_identity['fixture_lock_sha256']
    for name, fingerprint in host_identity['fixture_source_sha256'].items():
        assert digest(GRAPH / 'host-faults' / name) == fingerprint
    evidence = Path(tempfile.mkdtemp(prefix='session-demo-host-cases-', dir=EVIDENCE))
    print('EVIDENCE ' + str(evidence), flush=True)
    project = evidence / 'project'
    target = project / 'src/nomo'
    target.mkdir(parents=True)
    consumed = [ROOT / 'src/nomo' / name for name in (
        'bundle_codec.es', 'history_store.es', 'metadata_store.es', 'session_cli.es', 'session_cli_args.es',
        'session_demo.es', 'session_display.es', 'session_store.es', 'store_record.es', 'stub_snapshot.es',
        'conversation.es', 'session_state.es', 'text.es', 'loop.es', 'stub.es', 'config.es')]
    before = {str(path): digest(path) for path in consumed}
    for path in consumed:
        shutil.copyfile(path, target / path.name)
    shutil.copyfile(Path(__file__), evidence / 'driver.py')
    (project / 'etas.toml').write_text('''[package]
name = "owned-session-demo-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[[bin]]
name = "demo"
module = "nomo.session_demo"
flow = "demo"
''')
    identities = {str(path.relative_to(project)): digest(path) for path in project.rglob('*') if path.is_file()}
    result = {'sources': identities, 'protected_repository_sources': before,
              'host_identity': host_identity, 'cli_identity': cli_identity,
              'demo_host_identity': demo_identity, 'demo_host_identity_sha256': digest(demo_identity_path),
              'cache_mount': cache_mount,
              'driver_sha256': digest(evidence / 'driver.py'),
              'effective_profile': {'kind': 'embedded public Host, RunOptions::default; fixture manifest not used by Host',
                                    'entry_module': 'nomo.session_demo', 'entry_flow': 'demo',
                                    'other_services': 'denied', 'database_and_fault': 'explicit owned directory/fault per command'},
              'commands': [], 'passed': []}

    def record():
        (evidence / 'results.json').write_text(json.dumps(result, indent=2))

    def command(args, label):
        entry = {'command': list(map(str, args)), 'label': label}
        result['commands'].append(entry)
        record()
        process = subprocess.run(args, text=True, capture_output=True, timeout=90,
                                 env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
        entry.update(exit=process.returncode, stdout=process.stdout, stderr=process.stderr)
        record()
        assert process.returncode == 0, entry
        return process

    def invoke(database, args, fault='none'):
        observed = json.loads(command([host, project / 'src', 'nomo.session_demo', 'demo', database, fault, *args], args[0] if args else 'empty').stdout)
        assert observed['denied_services'] == observed['denied_writes'] == observed['writes_after_fault'] == 0, observed
        return observed

    def arguments(verb, session='demo-session', save='save1', binding='independent-demo-binding', text=None, steps=None, budget=None):
        args = [verb, '--session', session, '--save', save, '--binding', binding]
        if text is not None:
            args += ['--input', text]
        if steps is not None:
            args += ['--steps', str(steps)]
        if budget is not None:
            args += ['--budget', str(budget)]
        return args

    def no_writes(observed):
        assert observed['memory_mutations'] == observed['session_appends'] == observed['session_resolves'] == 0, observed

    def new_database(name):
        database = evidence / name
        database.mkdir()
        return database

    def passed(name):
        result['passed'].append(name)
        record()
        print('PASS ' + name, flush=True)

    command([CLI, 'check', '--all', project], 'check-all')
    database = new_database('invalid')
    for args in ([], ['init'], arguments('init', text='not-permitted'), arguments('init', steps=0),
                 arguments('init') + ['--session', 'duplicate'], arguments('init') + ['x'] * 14):
        observed = invoke(database, args)
        no_writes(observed)
        assert observed['reads'] == 0 and observed['stdout'].startswith('REFUSED ') and observed['diagnostics'] == [], observed
    passed('invalid_init_parsed_before_host_calls')
    for verb in ('save', 'show'):
        observed = invoke(database, arguments(verb, text='hello' if verb == 'save' else None))
        no_writes(observed)
        assert observed['stdout'] == 'REFUSED demo is not initialized\n', observed
    passed('missing_claim_never_initializes_on_save_or_show')

    database = new_database('roundtrip')
    initialized = invoke(database, arguments('init'))
    assert initialized['diagnostics'] == [] and initialized['stdout'].startswith('INITIALIZED '), initialized
    assert initialized['memory_mutations'] == 2 and initialized['session_resolves'] == 1 and initialized['session_appends'] == 0, initialized
    before_repeat = logical(database)
    for args in (arguments('init'), arguments('init', session='other'), arguments('save', text='hello', binding='wrong'),
                 arguments('save', text='hello', steps=2), arguments('show', save='wrong')):
        refused = invoke(database, args)
        no_writes(refused)
        assert refused['stdout'].startswith('REFUSED ') and 'SAVED ' not in refused['stdout'] and refused['diagnostics'] == [], refused
        assert len(refused['stdout'].splitlines()) == 1, 'Refusal must precede any stub transcript'
        assert logical(database) == before_repeat
    passed('repeat_conflicting_init_and_ready_identity_caps_fail_closed')
    saved = invoke(database, arguments('save', text='tool:echo:hello'))
    marker = 'SAVED turn_status=0 '
    saved_lines = [line for line in saved['stdout'].splitlines() if line.startswith(marker)]
    assert saved['diagnostics'] == [] and len(saved_lines) == 1, saved
    projection = json.loads(saved_lines[0][len(marker):])
    assert projection['history']['spent'] == 3 and [event['text'] for event in projection['history']['events']] == [
        'tool:echo:hello', 'hello', 'hello', 'stub received: hello'], projection
    assert saved['memory_mutations'] == 2 and saved['session_appends'] == saved['session_resolves'] == 1, saved
    before_show = logical(database)
    shown = invoke(database, arguments('show'), fault='read-only')
    no_writes(shown)
    assert shown['diagnostics'] == [] and json.loads(shown['stdout'].removeprefix('SHOW ')) == projection, shown
    assert logical(database) == before_show
    (evidence / 'before-show.json').write_text(json.dumps(before_show, indent=2))
    (evidence / 'after-show.json').write_text(json.dumps(logical(database), indent=2))
    lower = invoke(database, arguments('show', steps=1, budget=1), fault='read-only')
    no_writes(lower)
    lower_projection = json.loads(lower['stdout'].removeprefix('SHOW '))
    assert lower_projection['caps']['steps'] == lower_projection['caps']['turn_steps'] == 1
    assert lower_projection['history']['spent'] == 3 and lower_projection['history']['stopped']
    assert lower_projection['original_caps'] == projection['original_caps']
    higher = invoke(database, arguments('show', steps=16, budget=16), fault='read-only')
    no_writes(higher)
    assert json.loads(higher['stdout'].removeprefix('SHOW ')) == projection, higher
    repeated = invoke(database, arguments('save', text='another fresh turn'))
    assert repeated['memory_mutations'] == repeated['session_appends'] == repeated['session_resolves'] == 0
    assert repeated['stdout'] == 'REFUSED session metadata already exists\n', repeated
    assert logical(database) == before_show
    passed('actual_init_save_exit_read_only_show_and_lower_caps_second_save')

    for fault in ('pending', 'publish', 'publish-before-dispatch'):
        database = new_database('init-unknown-' + fault)
        uncertain = invoke(database, arguments('init'), fault=fault)
        assert uncertain['fault_fired'] and 'INITIALIZED ' not in uncertain['stdout'], uncertain
        assert 'REFUSED demo initialization unknown; no retry' in uncertain['stdout'], uncertain
        assert uncertain['post_fault_reads'] == 0 and uncertain['writes_after_fault'] == 0, uncertain
        assert uncertain['session_resolves'] == (0 if fault == 'pending' else 1), uncertain
        assert uncertain['stdout'] == 'REFUSED demo initialization unknown; no retry\n', uncertain
        owner, version = claim_state(database)
        assert owner == {'format': 1, 'phase': 'ready' if fault == 'publish' else 'claimed',
                         'session_id': 'demo-session', 'save_id': 'save1', 'binding': 'independent-demo-binding',
                         'maximum': 3, 'budget': 16}, owner
        assert version == (2 if fault == 'publish' else 1)
        if fault == 'publish-before-dispatch':
            assert any(item.get('provider_unavailable_before_dispatch') and not item['dispatched']
                       and not item['actual_sqlite_commit'] for item in uncertain['trace']), uncertain
        before_unknown = logical(database)
        repeated = invoke(database, arguments('init'))
        no_writes(repeated)
        assert 'REFUSED demo already claimed' in repeated['stdout'] and logical(database) == before_unknown, repeated
        if fault != 'publish':
            for verb in ('save', 'show'):
                refused = invoke(database, arguments(verb, text='must not run' if verb == 'save' else None), fault='read-only')
                no_writes(refused)
                assert refused['stdout'] == 'REFUSED demo initialization is incomplete; no retry or repair\n', refused
                assert logical(database) == before_unknown
        else:
            for args in (arguments('save', text='must not run', binding='wrong'),
                         arguments('save', text='must not run', steps=2)):
                refused = invoke(database, args, fault='read-only')
                no_writes(refused)
                assert refused['stdout'].startswith('REFUSED ') and len(refused['stdout'].splitlines()) == 1, refused
                assert logical(database) == before_unknown
            # A new invocation may independently confirm the exact durable ready
            # claim. This does not invent an acknowledgement for the failed init.
            saved = invoke(database, arguments('save', text='hello'))
            assert saved['diagnostics'] == [] and 'SAVED turn_status=0 ' in saved['stdout'], saved
            assert saved['memory_mutations'] == 2 and saved['session_appends'] == saved['session_resolves'] == 1, saved
            saved_projection = json.loads(next(line.removeprefix('SAVED turn_status=0 ') for line in saved['stdout'].splitlines()
                                              if line.startswith('SAVED turn_status=0 ')))
            after_save = logical(database)
            shown = invoke(database, arguments('show'), fault='read-only')
            no_writes(shown)
            assert json.loads(shown['stdout'].removeprefix('SHOW ')) == saved_projection and logical(database) == after_save
        passed('actual_init_' + fault + '_unknown_boundary_and_separate_restart')
    assert {str(path): digest(path) for path in consumed} == before
    assert {name: digest(project / name) for name in identities} == identities
    passed('repository_and_retained_sources_unchanged')
    print('PASS session demo Host cases ' + str(len(result['passed'])), flush=True)


if __name__ == '__main__':
    main()
