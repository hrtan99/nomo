#!/usr/bin/env python3
"""Real SQLite continuation counters, acknowledgement loss and SIGKILL/restart tests."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time

from session_state_probe import snapshot, event, reference, record as typed_record
from session_store_probe import fixture_source
from session_store_fault_probe import untag, contents

ROOT = Path(__file__).resolve().parent.parent
GRAPH = Path('/home/nomo/.cargo/etas0013')
BINDING = 'synthetic-binding-not-authority'
SESSION = 'continue-fixture'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(database):
    with sqlite3.connect('file:' + str(database / 'memory.sqlite3') + '?mode=ro', uri=True) as connection:
        values = [(untag(json.loads(value)), version) for value, version in connection.execute('SELECT value_json,version FROM memory_entries')]
    with sqlite3.connect('file:' + str(database / 'session.sqlite3') + '?mode=ro', uri=True) as connection:
        messages = connection.execute('SELECT COUNT(*) FROM session_messages').fetchone()[0]
    return next((value, version, messages) for value, version in values if 'snapshot' in value)


def args(verb, text=None, steps=3, budget=16, **changes):
    values = {'session': SESSION, 'save': 'save1', 'binding': BINDING, 'steps': str(steps), 'budget': str(budget)}
    if verb == 'continue':
        values.update(generation='0', **{'next-save': 'save2'})
    values.update(changes)
    result = [verb]
    for flag, value in values.items():
        result += ['--' + flag, str(value)]
    if text is not None:
        result += ['--input', text]
    return result


def main():
    identity_path = Path(os.environ['NOMO_CONTINUE_HOST_IDENTITY'])
    identity = json.loads(identity_path.read_text())
    host = Path(identity['binary'])
    assert digest(host) == identity['binary_sha256']
    assert {p: digest(identity_path.parent / p) for p in identity['sources']} == identity['sources']
    assert {p: digest(Path(p)) for p in identity['protected_graph']} == identity['protected_graph']
    evidence = Path(tempfile.mkdtemp(prefix='continue-host-cases-', dir=os.environ['NOMO_TEST_EVIDENCE']))
    print('EVIDENCE ' + str(evidence), flush=True)
    project = evidence / 'project'
    target = project / 'src/nomo'
    target.mkdir(parents=True)
    selected = ['core/conversation.es', 'core/text.es', 'session/session_state.es', 'model/stub.es', 'agent/loop.es', 'session/stub_snapshot.es',
                'session/bundle_codec.es', 'session/store_record.es', 'session/history_store.es', 'session/metadata_store.es', 'session/session_store.es',
                'cli/session_cli_args.es', 'entry/session_cli.es', 'session/session_display.es', 'entry/session_demo.es',
                'cli/continuation_args.es', 'session/continuation_state.es', 'entry/session_continue.es', 'session/demo_claim.es']
    for name in selected:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'src/nomo' / name, destination)
    app = project / 'src/app/main.es'
    app.parent.mkdir()
    inputs = evidence / 'inputs'
    inputs.mkdir()
    consumed = list((ROOT / 'src').rglob('*.es')) + [Path(__file__),
        *(ROOT / 'tests' / p for p in ('session_state_probe.py', 'session_store_probe.py', 'session_store_fault_probe.py', 'normal_graph_identity.py'))]
    before = {str(p.relative_to(ROOT)): digest(p) for p in consumed}
    for p in consumed:
        target = evidence / 'repository-inputs' / p.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, target)
    result = {'status': 'running', 'host_identity': identity, 'identity_sha256': digest(identity_path),
              'sources_before': before, 'commands': [], 'passed': [],
              'scope': 'test embedding only; real pinned SQLite, source policy unchanged, separate process per invocation'}

    def retain_sources():
        closure = {}
        for p in project.rglob('*.es'):
            sha = digest(p)
            target = inputs / (sha + '.es')
            if not target.exists():
                shutil.copyfile(p, target)
            closure[str(p.relative_to(project))] = {'sha256': sha, 'retained': str(target.relative_to(evidence))}
        return closure

    def save_result():
        (evidence / 'results.json').write_text(json.dumps(result, indent=2))

    def command(database, arguments, fault='none', pause=None, module='nomo.entry.session_demo', flow='demo', reject=None, loss=None, readback=None):
        command = [str(host), str(project / 'src'), module, flow, str(database), fault, *arguments]
        item = {'command': command, 'sources': retain_sources(), 'pause': pause, 'reject': reject, 'loss': loss, 'readback': readback}
        result['commands'].append(item)
        save_result()
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        marker = database / ('pause-' + str(len(result['commands'])) + '.json')
        if pause:
            environment.update(NOMO_CONTINUE_PAUSE=pause, NOMO_CONTINUE_MARKER=str(marker))
        if reject:
            environment['NOMO_CONTINUE_REJECT'] = reject
        if loss:
            environment['NOMO_CONTINUE_LOSS'] = loss
        if readback:
            environment['NOMO_CONTINUE_READBACK'] = str(readback)
        process = subprocess.Popen(command, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        started = time.monotonic()
        try:
            if pause:
                deadline = time.monotonic() + 90
                while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                assert marker.exists() and process.poll() is None, (pause, process.communicate(timeout=5))
                observation = json.loads(marker.read_text())
                process.send_signal(signal.SIGKILL)
                stdout, stderr = process.communicate(timeout=10)
                item.update(exit=process.returncode, stdout=stdout, stderr=stderr, observer=observation,
                            actual_signal='SIGKILL', marker_sha256=digest(marker))
                assert process.returncode == -signal.SIGKILL, item
            else:
                stdout, stderr = process.communicate(timeout=90)
                item.update(exit=process.returncode, stdout=stdout, stderr=stderr)
                assert process.returncode == 0, item
                observation = json.loads(stdout)
                assert observation['denied_services'] == observation['denied_writes'] == observation['writes_after_fault'] == 0, observation
                item['observer'] = observation
            item['backend'] = contents(database)
            item['elapsed_seconds'] = time.monotonic() - started
            save_result()
            return observation
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)

    def passed(name):
        result['passed'].append(name)
        save_result()
        print('PASS ' + name, flush=True)

    def no_work(observed):
        assert observed['memory_mutations'] == observed['session_resolves'] == observed['session_appends'] == 0, observed
        assert 'user: ' not in observed['stdout'] and 'SAVED ' not in observed['stdout'] and observed['stdout'].startswith('REFUSED '), observed

    template = evidence / 'seed-template'

    def copy_databases(source, target):
        for name in ('memory.sqlite3', 'session.sqlite3'):
            with sqlite3.connect('file:' + str(source / name) + '?mode=ro', uri=True) as incoming, sqlite3.connect(target / name) as outgoing:
                incoming.backup(outgoing)
        assert contents(target) == contents(source)

    def fixture(name, text='tool:echo:hello', budget=16):
        database = evidence / name
        database.mkdir()
        if template.exists() and text == 'tool:echo:hello' and budget == 16:
            copy_databases(template, database)
            result.setdefault('synthetic_fixture_clones', {})[name] = {'from': 'seed-template', 'backend': contents(database),
                'files': {p.name: digest(p) for p in database.iterdir() if p.suffix == '.sqlite3'}}
            save_result()
            return database
        initialized = command(database, args('init', budget=budget))
        assert initialized['diagnostics'] == [] and initialized['session_resolves'] == 1, initialized
        saved = command(database, args('save', text=text, budget=budget))
        assert saved['diagnostics'] == [] and 'SAVED turn_status=0 ' in saved['stdout'], saved
        if not template.exists():
            template.mkdir()
            copy_databases(database, template)
            result['initial_template_backend'] = contents(template)
            save_result()
        return database

    try:
        database = fixture('roundtrip')
        old, old_version, count = rows(database)
        new = command(database, args('continue', text='recall', steps=16))
        assert new['diagnostics'] == [] and new['memory_mutations'] == 3 and new['session_resolves'] == 2 and new['session_appends'] == 1, new
        assert new['stdout'].startswith('user: recall\nassistant: remembered: hello\nSAVED turn_status=0 '), new
        current, version, count = rows(database)
        assert version != old_version and current['snapshot']['generation'] == 1 and count == 2, current
        assert current['snapshot']['history']['spent'] == 4 and current['snapshot']['original_caps'] == old['snapshot']['original_caps'], current
        assert current['snapshot']['operations'] == old['snapshot']['operations'] and current['snapshot']['references'][:4] == old['snapshot']['references'], current
        before_reload = contents(database)
        shown = command(database, args('show', save='save2'), fault='read-only')
        assert shown['memory_mutations'] == shown['session_resolves'] == shown['session_appends'] == 0 and shown['stdout'].startswith('SHOW '), shown
        for arguments in [args('continue', text='recall'), args('show'), args('continue', text='recall', save='save2', generation=1, **{'next-save': 'save3'})]:
            no_work(command(database, arguments, fault='read-only'))
            assert contents(database) == before_reload
        passed('actual_current_reload_and_stale_refusals_with_two_explicit_api_resolves_no_old_dispatch')

        for fault, phase, messages, starts, resolves in [('pending', 'published', 1, 0, 0),
                                                       ('append', 'continuing', 2, 1, 2),
                                                       ('publish', 'continuing', 1, 0, 0),
                                                       ('conflict', 'published', 1, 0, 0)]:
            database = fixture('lost-' + fault)
            observed = command(database, args('continue', text='tool:echo:new'), fault=fault)
            assert observed['fault_fired'] and observed['writes_after_fault'] == observed['post_fault_reads'] == 0, observed
            assert observed['stdout'].count('user: ') == starts and 'SAVED ' not in observed['stdout'], observed
            assert observed['session_resolves'] == resolves, observed
            row, version, count = rows(database)
            assert row['phase'] == phase and count == messages, row
            assert row['snapshot']['history']['spent'] == (3 if fault in ('pending', 'conflict') else 6), row
            before_retry = contents(database)
            no_work(command(database, args('continue', text='tool:echo:new'), fault='read-only'))
            assert contents(database) == before_retry
            for save in ['save1', 'save2']:
                no_work(command(database, args('show', save=save), fault='read-only'))
            passed('real_sqlite_' + fault + '_no_blind_retry_and_no_restart_replay')

        for name, kwargs, phase, messages, resolves in [
            ('uncommitted-admission', {'reject': 'admission'}, 'published', 1, 0),
            ('uncommitted-publication', {'reject': 'publication'}, 'continuing', 2, 2),
            ('publication-ack-loss', {'loss': 'publication'}, 'published', 2, 2),
            ('initialization-ack-loss', {'loss': 'initialize'}, 'continuing', 1, 1),
            ('append-binding-ack-loss', {'loss': 'append-binding'}, 'continuing', 1, 2)]:
            database = fixture(name)
            observed = command(database, args('continue', text='tool:echo:new'), **kwargs)
            assert observed['fault_fired'] and observed['writes_after_fault'] == observed['post_fault_reads'] == 0 and 'SAVED ' not in observed['stdout'], observed
            row, version, count = rows(database)
            assert row['phase'] == phase and count == messages and observed['session_resolves'] == resolves, (name, row, observed)
            assert row['snapshot']['history']['spent'] == (3 if name == 'uncommitted-admission' else 6), row
            before_retry = contents(database)
            no_work(command(database, args('continue', text='tool:echo:new'), fault='read-only'))
            assert contents(database) == before_retry
            passed(name + '_consumed_fence_no_restart_replay')

        for ordinal in [1, 2, 3]:
            database = fixture('readback-' + str(ordinal))
            observed = command(database, args('continue', text='tool:echo:new'), readback=ordinal)
            assert observed['fault_fired'] and observed['fixture_mutations'] == 1 and observed['writes_after_fault'] == 0, observed
            assert 'SAVED ' not in observed['stdout'] and observed['session_resolves'] == (2 if ordinal == 3 else 0), observed
            before_retry = contents(database)
            no_work(command(database, args('continue', text='tool:echo:new'), fault='read-only'))
            assert contents(database) == before_retry
            passed('actual_competing_writer_readback_' + str(ordinal) + '_no_dispatch_or_restart_replay')

        points = ['after-fence-commit', 'before-admission-dispatch', 'after-admission-commit', 'after-admission-before-initialize', 'after-initialize',
                  'during-turn', 'before-append', 'after-append', 'before-publication', 'after-publication-commit']
        for point in points:
            database = fixture('kill-' + point)
            observed = command(database, args('continue', text='tool:echo:new'), pause=point)
            row, version, count = rows(database)
            assert row['snapshot']['history']['spent'] == (3 if point in ('after-fence-commit', 'before-admission-dispatch') else 6), row
            assert row['phase'] == ('published' if point in ('after-fence-commit', 'before-admission-dispatch', 'after-publication-commit') else 'continuing'), row
            assert count == (2 if point in ('after-append', 'before-publication', 'after-publication-commit') else 1), (point, count)
            assert 'SAVED ' not in observed['stdout'], observed
            before_retry = contents(database)
            no_work(command(database, args('continue', text='tool:echo:new'), fault='read-only'))
            assert contents(database) == before_retry
            passed('real_SIGKILL_' + point + '_absolute_reservation_no_replay')

        # Before dispatch there is no admitted turn or changed spending. No automatic
        # retry follows; this case is distinct from an interrupted durable admission.
        database = fixture('kill-before-admission')
        before_kill = contents(database)
        observed = command(database, args('continue', text='recall'), pause='before-fence-dispatch')
        assert observed['session_resolves'] == observed['session_appends'] == 0 and not observed['stdout'], observed
        assert contents(database) == before_kill
        passed('real_SIGKILL_before_first_fence_dispatch_no_turn_or_storage_effect_no_persisted_barrier_claim')
        database = fixture('first-fence-uncommitted')
        before_fence = contents(database)
        observed = command(database, args('continue', text='recall'), reject='fence')
        assert observed['fault_fired'] and not observed['session_resolves'] and not observed['session_appends'] and 'user: ' not in observed['stdout'], observed
        assert contents(database) == before_fence
        passed('first_fence_uncommitted_Unknown_zero_effect_no_persisted_barrier_claim')

        # Actual source-returned failure/budget stop settles measured cumulative work.
        for name, text, steps, budget, status, spent, disposition in [
            ('failure', 'stub:fail', 3, 16, 3, 4, 'validated'),
            ('pending-stop', 'tool:echo:new', 1, 16, 4, 4, 'recovery-required'),
            ('completed-stop', 'tool:echo:new', 2, 16, 4, 5, 'validated'),
            ('budget-stop', 'tool:echo:new', 3, 5, 4, 5, 'validated')]:
            database = fixture('settle-' + name)
            observed = command(database, args('continue', text=text, steps=steps, budget=budget))
            assert observed['diagnostics'] == [] and 'SAVED turn_status=' + str(status) in observed['stdout'], observed
            row, version, count = rows(database)
            assert row['snapshot']['history']['spent'] == spent and row['snapshot']['current_caps']['steps'] == budget, row
            shown = command(database, args('show', save='save2', steps=16, budget=16), fault='read-only')
            projection = json.loads(shown['stdout'].removeprefix('SHOW '))
            assert projection['history']['spent'] == spent and projection['disposition'] == disposition, projection
            assert projection['history']['stopped'] == (status == 4), projection
            passed('observed_source_' + name + '_actual_spending_and_lifecycle_published')

        # Policy tests use explicitly typed synthetic state, never arbitrary DB adoption.
        for name in ['stopped', 'pending', 'unknown', 'events-full', 'content-full', 'wrong-mode', 'unsupported-phase', 'unsupported-generation']:
            database = evidence / ('refuse-' + name)
            database.mkdir()
            command(database, args('init'))
            saved = snapshot()
            saved[1]['generation'] = 0
            for cap in ['original_caps', 'current_caps']:
                saved[1][cap][1]['turn_steps'] = 3
            state = saved[1]['history'][1]
            bodies = ['seed', '', 'OUTCOME']
            action, extra = 'save', []
            if name == 'stopped':
                state['stopped'] = True
                saved[1]['lifecycle'] = 'stopped'
            elif name in ['pending', 'unknown']:
                state['events'].pop()
                saved[1]['references'].pop()
                saved[1]['operations'][0][1]['status'] = name
                bodies.pop()
            elif name in ['events-full', 'content-full']:
                size = 28 if name == 'events-full' else 1
                state['events'] = [event(text='')] * size
                saved[1]['references'] = [reference()] * size
                saved[1]['operations'] = []
                bodies = [''] * size if size == 28 else ['x' * 7100]
            elif name == 'wrong-mode':
                saved[1]['mode'] = 'scripted-read'
                saved[1]['operations'][0][1]['scan_bytes'] = 4096
                saved[1]['ledger'][1]['scan_bytes'] = 4096
                for cap in ['original_caps', 'current_caps']:
                    saved[1][cap][1]['scan_bytes'] = 8192
            elif name == 'unsupported-phase':
                action, extra = 'seed-metadata', ['not-a-supported-phase']
            elif name == 'unsupported-generation':
                saved[1]['generation'] = 2
            app.write_text(fixture_source(saved[1]['mode'], saved))
            payload = json.dumps(['nomo-session-bundle-v1', SESSION, 'save1', *bodies])
            seeded = command(database, [action, SESSION, 'save1', payload, *extra], module='app.main', flow='main')
            assert seeded['diagnostics'] == [] and 'REFUSED ' not in seeded['stdout'], seeded
            before_retry = contents(database)
            no_work(command(database, args('continue', text='x' * 1024 if name == 'content-full' else 'recall'), fault='read-only'))
            assert contents(database) == before_retry
            passed('typed_' + name + '_refuses_before_admission_or_turn')

        database = fixture('populated-successor')
        app.write_text(fixture_source('stub'))
        command(database, ['setup', SESSION, 'save2'], module='app.main', flow='main')
        payload = json.dumps(['nomo-session-bundle-v1', SESSION, 'save2', 'not-empty'])
        seeded = command(database, ['seed-body', SESSION, 'save2', json.dumps(['nomo-session-bundle-v1', SESSION, 'save2', 'seed', '', 'OUTCOME']), payload], module='app.main', flow='main')
        assert seeded['diagnostics'] == [] and 'SEEDED_BODY' in seeded['stdout'], seeded
        observed = command(database, args('continue', text='recall'))
        assert observed['session_resolves'] == 1 and observed['session_appends'] == 0 and 'user: ' not in observed['stdout'] and 'REFUSED successor namespace is not empty' in observed['stdout'], observed
        no_work(command(database, args('continue', text='recall'), fault='read-only'))
        passed('populated_successor_refused_before_turn_append_and_fence_retained')

        result['sources_after'] = {name: digest(ROOT / name) for name in before}
        assert result['sources_after'] == before
        assert {p: digest(Path(p)) for p in identity['protected_graph']} == identity['protected_graph']
        result['status'] = 'passed'
        passed('retained_sources_and_normal_graph_unchanged')
    except BaseException:
        result['status'] = 'failed'
        save_result()
        raise


if __name__ == '__main__':
    main()
