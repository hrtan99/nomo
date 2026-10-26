#!/usr/bin/env python3
"""Ordinary Docker demo observer; no generated manifest, test Host or product policy."""
import argparse
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--evidence-parent', type=Path, default=Path(tempfile.gettempdir()))
    options = parser.parse_args()
    root = options.project_root.resolve()
    launcher = root / 'scripts/session-demo.sh'
    assert launcher.is_file(), 'ordinary repository launcher must be integrated first'
    assert options.evidence_parent.is_dir(), 'pre-existing owned evidence parent required'
    evidence = Path(tempfile.mkdtemp(prefix='ordinary-demo-', dir=options.evidence_parent.resolve()))
    print('EVIDENCE ' + str(evidence), flush=True)
    summary = {'status': 'running', 'commands': [], 'passed': [], 'snapshots': {},
               'scope': 'ordinary repository launcher, normal installed CLI, real separate Docker invocations',
               'limits': ['No test Host or generated manifest on ordinary route.',
                          'Outer Etas wrapper maps nonzero source status to CLI abort/OS 3; application markers/JSON are also asserted.',
                          'Canonical logical SQLite equality is checked; backend schema/WAL opening activity is allowed.',
                          'Zero product Host calls require separately labelled supplementary counter tests.']}
    docker = ['docker', 'compose', '--project-directory', str(root), '-f', str(root / 'compose.yaml'),
              '-f', str(root / 'tests/fixtures/etas013/compose.yaml'),
              '-f', str(root / 'config/etas-runtime-cache-compose.yaml'),
              'run', '--rm', '--no-deps', '--tty=false', 'dev']

    def save():
        (evidence / 'results.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))

    def source_hashes():
        paths = [root / name for name in ('etas.toml', 'etas.lock', 'compose.yaml', 'Dockerfile',
                 'config/session-demo-compose.yaml', 'config/etas-runtime-cache-compose.yaml',
                 'tests/fixtures/etas013/compose.yaml',
                 'scripts/session-demo.sh', 'tests/normal_graph_identity.py',
                 'scripts/etas-latest-cli-bootstrap.py', 'config/etas-latest-main.json')]
        paths += list((root / 'src').rglob('*.es'))
        paths += [root / 'patches/etas-0013' / (name + '.Cargo.lock')
                  for name in ('core', 'frontend', 'interpreter', 'cli')]
        return {str(p.relative_to(root)): digest(p) for p in sorted(set(paths))}

    def local_index():
        return {name: {'exists': (root / '.etas' / name).exists(),
                       'sha256': digest(root / '.etas' / name) if (root / '.etas' / name).is_file() else None}
                for name in ('package-index.json', 'package-index.lock')}

    def run(label, command, allowed=(0,), timeout=180):
        item = {'label': label, 'command': list(map(str, command)), 'cwd': str(root), 'timeout': timeout}
        summary['commands'].append(item)
        save()
        try:
            result = subprocess.run(command, cwd=root, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            item.update(timeout_expired=True, stdout=repr(error.stdout), stderr=repr(error.stderr))
            save()
            raise
        item.update(exit=result.returncode, stdout=result.stdout.decode(), stderr=result.stderr.decode())
        save()
        assert result.returncode in allowed, item
        return item

    def fresh(name):
        directory = evidence / name
        # Admission is external and exclusive; launcher must never auto-create it.
        run('exclusive-mkdir-' + name, ['mkdir', str(directory)])
        return directory

    def args(session, steps=3, budget=16, binding=BINDING, save_id='save1'):
        return ['--session', session, '--save', save_id, '--binding', binding,
                '--steps', str(steps), '--budget', str(budget)]

    def invoke(label, action, directory, arguments, allowed=(0, 3)):
        return run(label, ['bash', str(launcher), action, str(directory), *arguments], allowed)

    def observe(label, directory):
        logical, raw = inspect_store(directory)
        target = evidence / (label + '.sqlite.json')
        target.write_text(json.dumps({'logical': logical, 'raw_dumps': raw}, indent=2, ensure_ascii=False))
        summary['snapshots'][label] = {'path': target.name, 'sha256': digest(target)}
        save()
        return logical

    def refused(result, diagnostic=None):
        assert result['exit'] == 3 and 'Nomo session demo refused' in result['stderr'], result
        assert 'REFUSED ' in result['stdout'], result
        assert not any(line.startswith(('SAVED ', 'SHOW ', 'INITIALIZED ')) for line in result['stdout'].split('\n')), result
        if diagnostic is not None:
            assert diagnostic in result['stdout'], result

    def projection(result, prefix, turn_status=None):
        assert result['exit'] == 0, result
        lines = [line for line in result['stdout'].split('\n') if line.startswith(prefix)]
        assert len(lines) == 1, result
        encoded = lines[0][len(prefix):]
        if prefix == 'SAVED ':
            status = 'turn_status=' + str(turn_status) + ' '
            assert encoded.startswith(status), result
            encoded = encoded[len(status):]
        else:
            assert result['stdout'] == lines[0] + '\n', result
        assert encoded.startswith('{') and len(encoded) <= 131072
        assert all(32 <= ord(char) < 127 for char in encoded), 'raw terminal control/non-ASCII display'
        return json.loads(encoded)

    def note(name):
        summary['passed'].append(name)
        save()
        print('PASS ' + name, flush=True)

    try:
        shutil.copyfile(__file__, evidence / 'driver.py')
        summary['driver_sha256'] = digest(evidence / 'driver.py')
        summary['local_index_before'] = local_index()
        summary['sources_before'] = source_hashes()
        for name, fingerprint in summary['sources_before'].items():
            target = evidence / 'workspace-inputs' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, target)
            assert digest(target) == fingerprint
        run('normal-image', ['docker', 'image', 'inspect', 'nomo-dev:ubuntu-26.04-arm64', '--format', '{{.Id}}'])
        mount_probe = '''import json
from pathlib import Path
rows = [line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()
        if line.split()[4] in ('/workspace', '/home/nomo/.cargo', '/workspace/.etas')]
parents = [row for row in rows if row[4] != '/workspace/.etas']
children = [row for row in rows if row[4] == '/workspace/.etas']
cache = Path('/workspace/.etas')
stat = cache.stat()
entries = sorted(path.name for path in cache.iterdir())
print(json.dumps({'effective_mounts': rows, 'cache_uid': stat.st_uid, 'cache_gid': stat.st_gid,
                  'cache_mode': oct(stat.st_mode & 0o777), 'fresh_cache_entries': entries}))
if len(parents) != 2 or not all('ro' in row[5].split(',') for row in parents):
    raise RuntimeError('workspace and normal cache must be effectively read-only')
if len(children) != 1 or children[0][children[0].index('-') + 1] != 'tmpfs':
    raise RuntimeError('project cache must be a per-container tmpfs')
if not {'rw', 'noexec', 'nosuid', 'nodev'} <= set(children[0][5].split(',')):
    raise RuntimeError('project cache mount flags mismatch')
if stat.st_uid != 10001 or stat.st_gid != 10001 or stat.st_mode & 0o777 != 0o700 or entries:
    raise RuntimeError('project cache must be owned, private and empty in each fresh container')
'''
        run('effective-read-only-helper-mounts', docker + ['python3', '-B', '-c', mount_probe])
        run('normal-provenance', docker + ['python3', '-B', '/workspace/tests/normal_graph_identity.py'])
        baseline = run('unchanged-default-stub', docker + ['etas', 'run', '/workspace', '--allow-effects', '--args', '--once', 'hello'])
        assert baseline['stdout'] == 'user: hello\nassistant: stub: hello\n', baseline
        effects = run('default-console-only', docker + ['etas', 'effects', '/workspace', '--flow', 'main'])
        actions = [line.strip() for line in effects['stdout'].splitlines() if line.strip().startswith('requested actions:')]
        assert actions == ['requested actions: [Console.stdin_read_line, Console.stdout_write]'], effects
        note('normal_provenance_and_unchanged_default_stub')

        absent = evidence / 'absent-bind'
        rejected = invoke('absent-bind-refused', 'show', absent, args('absent'), allowed=(64,))
        assert not absent.exists(), 'launcher silently created missing bind source'
        assert not any(marker in rejected['stdout'] for marker in ('SHOW ', 'SAVED ', 'INITIALIZED ')), rejected
        missing = fresh('missing-databases')
        invoke('missing-databases-refused', 'show', missing, args('missing'), allowed=(2,))
        assert list(missing.iterdir()) == [], 'open-existing profile created a database'
        note('absent_bind_and_missing_database_refuse_without_creation')

        completed_store = None
        scenarios = [
            ('completed', 3, 16, 3, 0, False, [('user', 'input', '', 'tool:echo:abc'), ('model', 'request', 'echo', 'abc'),
                ('tool', 'complete', 'echo', 'abc'), ('assistant', 'final', '', 'stub received: abc')]),
            ('pending', 1, 16, 1, 4, True, [('user', 'input', '', 'tool:echo:abc'), ('model', 'request', 'echo', 'abc'),
                ('error', 'error', '', 'step limit exhausted')]),
        ]
        for label, steps, budget, spent, status, pending, events in scenarios:
            directory = fresh(label)
            session = 'ordinary-' + label
            arguments = args(session, steps, budget)
            initialized = invoke(label + '-init', 'init', directory, arguments)
            assert initialized['exit'] == 0 and initialized['stdout'] == INITIALIZED, initialized
            rows, count = metadata(directory)
            assert rows == [{'format': 1, 'phase': 'ready', 'session_id': session, 'save_id': 'save1',
                             'binding': BINDING, 'maximum': steps, 'budget': budget}] and count == 0, (rows, count)
            ready = observe(label + '-initialized', directory)
            refused(invoke(label + '-show-before-save', 'show', directory, arguments), 'session metadata missing')
            assert observe(label + '-show-before-save-after', directory) == ready
            wrong_caps = args(session, 2 if steps == 3 else 3, budget) + ['--input', 'hello']
            mismatch = invoke(label + '-save-caps-refused', 'save', directory, wrong_caps)
            refused(mismatch, 'demo save caps differ from initialization')
            assert 'user:' not in mismatch['stdout'] and observe(label + '-caps-refusal-after', directory) == ready
            saved = invoke(label + '-save', 'save', directory, arguments + ['--input', 'tool:echo:abc'])
            wanted = expected(session, events, spent, steps, budget, pending)
            assert projection(saved, 'SAVED ', status) == wanted, saved
            rows, count = metadata(directory)
            stored_rows = [row for row in rows if 'snapshot' in row]
            assert len(rows) == 2 and len(stored_rows) == 1 and count == 1, (rows, count)
            snapshot = stored_rows[0]['snapshot']
            assert stored_rows[0]['phase'] == 'published' and stored_rows[0]['save_id'] == 'save1'
            assert snapshot['lifecycle'] == ('recovery-required' if pending else 'active')
            assert snapshot['history'] == dict(wanted['history'], stopped=False,
                                               events=[dict(event, text='') for event in wanted['history']['events']])
            assert snapshot['original_caps'] == snapshot['current_caps'] == wanted['caps']
            before = observe(label + '-saved', directory)
            shown = invoke(label + '-separate-show', 'show', directory, arguments)
            assert projection(shown, 'SHOW ') == wanted, shown
            assert observe(label + '-show-after', directory) == before
            refused(invoke(label + '-conflicting-init', 'init', directory, arguments), 'demo already claimed')
            assert observe(label + '-conflicting-init-after', directory) == before
            refused(invoke(label + '-new-id-reinit', 'init', directory, args('different-session', steps, budget)), 'demo already claimed')
            assert observe(label + '-new-id-reinit-after', directory) == before
            refused(invoke(label + '-second-save', 'save', directory, arguments + ['--input', 'hello']), 'session metadata already exists')
            assert observe(label + '-second-save-after', directory) == before
            for kind, bad in [('binding', args(session, steps, budget, binding='wrong')),
                              ('session', args('wrong', steps, budget)), ('save', args(session, steps, budget, save_id='wrong'))]:
                diagnostic = ('current checkpoint is not associated with demo claim; no historical show'
                              if kind == 'save' else 'demo identity or binding mismatch')
                refused(invoke(label + '-wrong-' + kind, 'show', directory, bad), diagnostic)
                assert observe(label + '-wrong-' + kind + '-after', directory) == before
            lower = deepcopy(wanted)
            lower['caps'].update(steps=1, turn_steps=1)
            lower['history']['stopped'] = True
            lowered = projection(invoke(label + '-lower-caps', 'show', directory, args(session, 1, 1)), 'SHOW ')
            assert lowered == lower, (lowered, lower)
            assert observe(label + '-lower-caps-after', directory) == before
            assert projection(invoke(label + '-higher-caps', 'show', directory, args(session, 16, 16)), 'SHOW ') == wanted
            assert observe(label + '-higher-caps-after', directory) == before
            invalid = [('show-input', 'show', arguments + ['--input', 'hello']),
                       ('invalid-limit', 'show', args(session, 0, budget)),
                       ('duplicate', 'show', arguments + ['--binding', BINDING]),
                       ('raw-control', 'save', arguments + ['--input', 'hello\n'])]
            for name, action, bad in invalid:
                result = invoke(label + '-invalid-' + name, action, directory, bad)
                refused(result)
                assert 'user:' not in result['stdout'] and 'model:' not in result['stdout'], result
                assert observe(label + '-invalid-' + name + '-after', directory) == before
            if not pending:
                completed_store = directory
            note(label + '_ordinary_init_save_separate_show_and_refusals_exact_logical_state')

        limited = fresh('limited-budget')
        limited_args = args('ordinary-limited', 3, 2)
        limited_init = invoke('limited-init', 'init', limited, limited_args)
        assert limited_init['exit'] == 0 and limited_init['stdout'] == INITIALIZED, limited_init
        limited_events = [('user', 'input', '', 'tool:echo:abc'), ('model', 'request', 'echo', 'abc'),
                          ('tool', 'complete', 'echo', 'abc'), ('error', 'error', '', 'invocation step budget exhausted')]
        limited_wanted = expected('ordinary-limited', limited_events, 2, 3, 2)
        limited_saved = invoke('limited-save', 'save', limited, limited_args + ['--input', 'tool:echo:abc'])
        assert projection(limited_saved, 'SAVED ', 4) == limited_wanted
        before = observe('limited-saved', limited)
        higher = invoke('limited-show-higher-budget', 'show', limited, args('ordinary-limited', 16, 16))
        assert projection(higher, 'SHOW ') == limited_wanted
        assert observe('limited-after-higher-budget', limited) == before
        note('higher_requested_budget_cannot_refill_completed_limited_work')

        partial = fresh('partial-missing-session')
        # Test-only partial-store fixture: copy the complete committed Memory DB,
        # including WAL frames; never manufacture application claims or policy.
        with closing(sqlite3.connect((completed_store / 'memory.sqlite3').as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(partial / 'memory.sqlite3')) as destination:
                source.backup(destination)
        before = observe('partial-before', partial)
        invoke('partial-missing-session-refused', 'show', partial, args('ordinary-completed'), allowed=(2,))
        assert not (partial / 'session.sqlite3').exists()
        assert observe('partial-after', partial) == before
        note('partial_store_open_existing_refusal_does_not_create_missing_session')
        run('fresh-runtime-cache-after-separate-containers', docker + ['python3', '-B', '-c', mount_probe])
        summary['local_index_after'] = local_index()
        assert summary['local_index_after'] == summary['local_index_before'], 'local optional index/lock changed'
        summary['sources_after'] = source_hashes()
        assert summary['sources_after'] == summary['sources_before'], 'ordinary sources changed during verification'
        summary['status'] = 'passed ordinary Docker demo route; supplementary Host-counter evidence remains separate'
    except BaseException as error:
        summary.update(status='failed', failure=repr(error))
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
