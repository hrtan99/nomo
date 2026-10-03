#!/usr/bin/env python3
"""SESSION-CLI-001A process tests; product parsing, mapping and storage stay in Etas."""
import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

from session_state_probe import snapshot, event, reference
from session_store_fault_probe import contents, stored
from session_store_probe import CLI, EVIDENCE, GRAPH, fixture_source, materialize

ROOT = Path(__file__).resolve().parent.parent
HARNESS = GRAPH / 'target/debug/nomo-session-store-host-faults'
BINDING = 'independent-fixture-binding'
SHARED = ('conversation.es', 'session_state.es', 'text.es', 'loop.es', 'stub.es', 'config.es')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cli_args(action, session='cli-session', save='save1', binding=BINDING, text=None, steps=None, budget=None):
    values = [action, '--session', session, '--save', save, '--binding', binding]
    if text is not None:
        values += ['--input', text]
    if steps is not None:
        values += ['--steps', str(steps)]
    if budget is not None:
        values += ['--budget', str(budget)]
    return values


def expected(session, events, spent, steps=3, budget=16, pending=False):
    """Independent oracle for the deliberately finite real-stub cases below."""
    records = [dict(zip(('role', 'kind', 'name', 'text'), value)) for value in events]
    references = []
    operations = []
    for index, record in enumerate(records):
        if record['role'] == 'model':
            operation = 'stub-request-' + str(index)
            references.append({'operation': operation, 'phase': 'request'})
            operations.append({'id': operation, 'status': 'pending' if pending else 'completed',
                               'attempts': 0, 'tokens': 0, 'scan_bytes': 0})
        elif record['role'] == 'tool':
            references.append({'operation': operations[-1]['id'], 'phase': 'outcome'})
        else:
            references.append({'operation': '', 'phase': ''})
    caps = {'steps': budget, 'turn_steps': steps, 'attempts': 0, 'tokens': 0, 'scan_bytes': 0}
    return {'session_id': session, 'generation': 0, 'mode': 'stub', 'binding': BINDING,
            'disposition': 'recovery-required' if pending else 'validated',
            'history': {'events': records, 'characters': sum(len(e['name']) + len(e['text']) for e in records),
                        'spent': spent, 'stopped': pending or spent >= budget},
            'references': references, 'operations': operations, 'original_caps': caps, 'caps': caps,
            'ledger': {'attempts': 0, 'tokens': 0, 'scan_bytes': 0, 'step_unit': 'steps',
                       'attempt_unit': 'attempts', 'token_unit': 'total-input-output-tokens', 'scan_unit': 'bytes'}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--section', choices=('arguments', 'roundtrip', 'state', 'all'), default='all')
    options = parser.parse_args()
    identity = json.loads((GRAPH / 'host-faults-identity.json').read_text())
    assert digest(HARNESS) == identity['fixture_binary_sha256']
    assert digest(CLI) == json.loads((GRAPH / 'binary.json').read_text())['sha256']
    protected = ['etas.toml', 'etas.lock', 'src/nomo/main.es', 'src/nomo/config.es', 'src/nomo/session_state.es']
    original = {name: digest(ROOT / name) for name in protected}
    project = Path(tempfile.mkdtemp(prefix='session-cli-cases-', dir=EVIDENCE))
    print('EVIDENCE ' + str(project), flush=True)
    source = materialize(project)
    for name in SHARED:
        shutil.copyfile(ROOT / 'src/nomo' / name, project / 'src/nomo' / name)
    source.write_text(fixture_source('stub'))
    (project / 'etas.toml').write_text('''[package]
name = "nomo-isolated-session-cli-test"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[[bin]]
name = "session"
module = "nomo.session_cli"
flow = "run_session"
''')
    generated = project / 'inputs'
    generated.mkdir()
    results, passed = [], []

    def retain(data, suffix):
        checksum = hashlib.sha256(data).hexdigest()
        path = generated / (checksum + suffix)
        if path.exists():
            assert path.read_bytes() == data
        else:
            path.write_bytes(data)
        return {'path': str(path.relative_to(project)), 'sha256': checksum}

    sources = {str(path.relative_to(project)): retain(path.read_bytes(), '.es')
               for path in (project / 'src').rglob('*.es')}
    drivers = {name: retain((ROOT / 'tests' / name).read_bytes(), '.py') for name in
               ('session_cli_probe.py', 'session_store_probe.py', 'session_store_fault_probe.py', 'session_state_probe.py')}
    (project / 'sources.json').write_text(json.dumps({'sources': sources, 'drivers': drivers,
        'host_identity': identity, 'protected': original}, indent=2))

    def note(name):
        passed.append(name)
        (project / 'summary.json').write_text(json.dumps({'passed': passed, 'count': len(passed)}, indent=2))
        print('PASS ' + name, flush=True)

    def run(database, arguments, module='nomo.session_cli', fault='none', actual_cli=False):
        entry_flow = 'main' if module == 'app.main' else 'run_session'
        command = ([str(CLI), 'run', str(project), '--flow', entry_flow, '--allow-effects', '--args', *arguments] if actual_cli else
                   [str(HARNESS), str(project / 'src'), module, entry_flow, str(database), fault, *arguments])
        profile = {'kind': 'CLI environment' if actual_cli else 'embedded Host, RunOptions::default; no CLI profile loaded',
                   'memory_sqlite': str(database / 'memory.sqlite3'), 'session_sqlite': str(database / 'session.sqlite3'),
                   'module': module, 'flow': entry_flow, 'fault': fault, 'binary_sha256': digest(CLI if actual_cli else HARNESS)}
        entry = source if module == 'app.main' else project / 'src/nomo/session_cli.es'
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1',
                   ETAS_HOST_MEMORY='sqlite:' + str(database / 'memory.sqlite3'),
                   ETAS_HOST_SESSION='sqlite:' + str(database / 'session.sqlite3'))
        retained_inputs = {
            'entry': retain(entry.read_bytes(), '.es'), 'fixture': retain(source.read_bytes(), '.es'),
            'actual_sources': {str(path.relative_to(project)): retain(path.read_bytes(), '.es')
                               for path in (project / 'src').rglob('*.es')},
            'manifest': retain((project / 'etas.toml').read_bytes(), '.toml'),
            'profile': retain(json.dumps(profile, sort_keys=True).encode(), '.profile.json'),
        }
        process = subprocess.run(command, text=True, capture_output=True, env=env, timeout=90)
        result = {'command': command, 'exit': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr,
                  **retained_inputs}
        results.append(result)
        (project / 'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
        assert process.returncode == 0, result
        if actual_cli:
            return result
        observed = json.loads(process.stdout)
        assert observed['denied_services'] == observed['denied_writes'] == observed['writes_after_fault'] == 0, observed
        return observed

    def new_database(name):
        database = project / name
        database.mkdir()
        return database

    def seed(database, action, session, save='save1', bodies=None, extra=(), mode='stub', supplied=None):
        source.write_text(fixture_source(mode, supplied))
        payload = json.dumps(['nomo-session-bundle-v1', session, save, *(bodies or ['seed', '', 'outcome'])], ensure_ascii=False)
        result = run(database, [action, session, save, payload, *extra], module='app.main')
        assert result['diagnostics'] == [], result
        return result

    def no_storage(result, reads=False):
        assert result['memory_mutations'] == result['session_appends'] == result['session_resolves'] == 0, result
        if not reads:
            assert result['reads'] == 0, result

    def projection(result, prefix, expected_turn_status=None):
        lines = [line for line in result['stdout'].splitlines() if line.startswith(prefix)]
        assert len(lines) == 1, result
        encoded = lines[0][len(prefix):]
        if prefix == 'SAVED ':
            assert expected_turn_status is not None, 'SAVED needs an independent original Turn.status oracle'
            status = 'turn_status=' + str(expected_turn_status) + ' '
            assert encoded.startswith(status), result
            encoded = encoded[len(status):]
        else:
            assert prefix == 'SHOW ' and expected_turn_status is None, prefix
            assert encoded.startswith('{'), 'SHOW must not invent historical numeric turn status'
        assert len(encoded.encode()) <= 131072 and all(32 <= ord(c) <= 126 for c in encoded), encoded
        decoded = json.loads(encoded)
        assert 'turn_status' not in decoded, 'Turn.status is not part of the stored Projection schema'
        return decoded

    if options.section in ('arguments', 'all'):
        database = new_database('rejected-arguments')
        valid_show = cli_args('show')
        valid_save = cli_args('save', text='hello')
        invalid = [[], ['show'], ['resume', *valid_show[1:]], ['--help', 'show'],
                   cli_args('save'), cli_args('show', text='hello'),
                   valid_show + ['--session', 'duplicate'], valid_save + ['--input', 'duplicate'],
                   valid_save + ['--budget', '2', '--budget', '3'], valid_show + ['--steps'],
                   valid_show + ['--unknown', 'x'], valid_show + ['trailing'],
                   valid_save + ['--model', 'real'], valid_show + ['--resume', 'yes'],
                   valid_save + ['--steps', '2', '--budget', '3', '--save', 'duplicate']]
        invalid += [valid_show + ['--steps', value] for value in ('0', '17', '01', '+1', '-1', '1.0', ' 1', '1 ', '1e0')]
        invalid += [valid_show + ['--budget', value] for value in ('0', '17', '01', '-2')]
        invalid += [cli_args('save', text=value) for value in ('', '  ', '/help', '\nhello', 'hello\n', 'hello\r', 'hello\t', '雪', 'a' * 1025)]
        invalid += [cli_args('show', session=value) for value in ('', 'a' * 129, '\n', '\x1b', '雪')]
        invalid += [cli_args('show', save=value) for value in ('', 'a' * 129, '\t')]
        invalid += [cli_args('show', binding=value) for value in ('', 'a' * 129, '\r', '雪')]
        for index, arguments in enumerate(invalid):
            result = run(database, arguments)
            no_storage(result)
            assert result['diagnostics'] == [] and result['stdout'].startswith('REFUSED '), result
            assert result['value'] == {'kind': 'number', 'type': 'i32', 'value': '2'}, result
            assert 'SAVED ' not in result['stdout'] and 'SHOW ' not in result['stdout'], result
            note('arguments_' + str(index) + '_refused_before_storage')
        help_result = run(database, ['--help'])
        no_storage(help_result)
        assert help_result['diagnostics'] == [] and 'SAVED ' not in help_result['stdout'], help_result
        note('help_has_no_storage_effects')
        before = contents(database)
        refused = run(database, [], actual_cli=True)
        assert refused['exit'] == 0 and refused['stdout'].startswith('REFUSED '), refused
        assert 'SAVED ' not in refused['stdout'] and 'SHOW ' not in refused['stdout'] and contents(database) == before, refused
        note('actual_cli_refusal_uses_output_contract_shell_exit_remains_zero')

    if options.section in ('roundtrip', 'all'):
        user = lambda text: ('user', 'input', '', text)
        model = ('model', 'request', 'echo', 'hello')
        tool = ('tool', 'complete', 'echo', 'hello')
        failure = lambda text: ('error', 'error', '', text)
        cases = [
            ('plain', '  hello  ', 3, 16, [user('hello'), ('assistant', 'final', '', 'stub: hello')], 1, False, 0),
            ('echo', 'tool:echo:hello', 3, 16, [user('tool:echo:hello'), model, tool, ('assistant', 'final', '', 'stub received: hello')], 3, False, 0),
            ('stub-failure', 'stub:fail', 3, 16, [user('stub:fail'), failure('stub failure')], 1, False, 3),
            ('unknown-tool', 'tool:nope:hello', 3, 16, [user('tool:nope:hello'), ('model', 'request', 'nope', 'hello'), ('tool', 'error', 'nope', 'unknown tool')], 2, False, 3),
            ('fake-tool-error', 'tool:echo:fail', 3, 16, [user('tool:echo:fail'), ('model', 'request', 'echo', 'fail'), ('tool', 'error', 'echo', 'fake tool failure')], 2, False, 3),
            ('request-only', 'tool:echo:hello', 1, 16, [user('tool:echo:hello'), model, failure('step limit exhausted')], 1, True, 4),
            ('tool-only', 'tool:echo:hello', 2, 16, [user('tool:echo:hello'), model, tool, failure('step limit exhausted')], 2, False, 4),
            ('budget-request', 'tool:echo:hello', 3, 1, [user('tool:echo:hello'), model, failure('invocation step budget exhausted')], 1, True, 4),
            ('budget-completed', 'tool:echo:hello', 3, 2, [user('tool:echo:hello'), model, tool, failure('invocation step budget exhausted')], 2, False, 4),
            ('upper-settings', 'hello', 16, 16, [user('hello'), ('assistant', 'final', '', 'stub: hello')], 1, False, 0),
        ]
        for name, text, steps, budget, events, spent, pending, turn_status in cases:
            database = new_database('roundtrip-' + name)
            session = 'cli-' + name
            seed(database, 'setup', session)
            arguments = cli_args('save', session=session, text=text, steps=steps, budget=budget)
            saved = run(database, arguments)
            wanted = expected(session, events, spent, steps, budget, pending)
            assert saved['diagnostics'] == [] and projection(saved, 'SAVED ', turn_status) == wanted, saved
            assert saved['memory_mutations'] == 2 and saved['session_appends'] == saved['session_resolves'] == 1, saved
            row, version, count = stored(database)
            assert row['phase'] == 'published' and version == 2 and count == 1, row
            assert row['snapshot']['lifecycle'] == ('recovery-required' if pending else 'active'), row
            # Accepted storage keeps descriptors/counters in Memory metadata
            # and event text in the Session bundle. Original stopped=false must
            # survive; exact SAVED/SHOW projections verify reconstructed bodies.
            metadata_history = dict(wanted['history'], stopped=False,
                                    events=[dict(event, text='') for event in wanted['history']['events']])
            assert row['snapshot']['history'] == metadata_history, row
            assert row['snapshot']['original_caps'] == wanted['original_caps'], row
            assert row['snapshot']['current_caps'] == wanted['caps'], row
            assert row['snapshot']['references'] == wanted['references'], row
            assert row['snapshot']['ledger'] == wanted['ledger'] and row['snapshot']['operations'] == wanted['operations'], row
            before = contents(database)
            shown = run(database, cli_args('show', session=session, steps=steps, budget=budget), fault='read-only')
            no_storage(shown, reads=True)
            assert shown['diagnostics'] == [] and projection(shown, 'SHOW ') == wanted, shown
            assert len(shown['stdout'].splitlines()) == 1 and contents(database) == before, shown
            repeated = run(database, arguments)
            assert 'SAVED ' not in repeated['stdout'] and 'REFUSED session metadata already exists' in repeated['stdout'], repeated
            assert repeated['memory_mutations'] == repeated['session_appends'] == 0 and contents(database) == before, repeated
            note('actual_stub_' + name + '_save_exit_read_only_show_exact')
        database = new_database('actual-cli-processes')
        seed(database, 'setup', 'actual-cli')
        saved = run(database, cli_args('save', session='actual-cli', text='tool:echo:hello'), actual_cli=True)
        assert projection(saved, 'SAVED ', 0) == expected('actual-cli', cases[1][4], 3), saved
        before = contents(database)
        shown = run(database, cli_args('show', session='actual-cli'), actual_cli=True)
        assert projection(shown, 'SHOW ') == expected('actual-cli', cases[1][4], 3) and contents(database) == before, shown
        note('actual_opt_in_cli_two_process_roundtrip_defaults')
        database = new_database('maximum-identifiers')
        session, save_id, binding = 's' * 128, 'v' * 128, 'b' * 126 + chr(92) + chr(34)
        seed(database, 'setup', session, save=save_id)
        arguments = ['save', '--input', 'hello', '--binding', binding, '--save', save_id,
                     '--session', session, '--budget', '16', '--steps', '3']
        saved = run(database, arguments)
        wanted = expected(session, [('user', 'input', '', 'hello'), ('assistant', 'final', '', 'stub: hello')], 1)
        wanted['binding'] = binding
        assert projection(saved, 'SAVED ', 0) == wanted, saved
        before = contents(database)
        shown = run(database, ['show', '--binding', binding, '--save', save_id, '--session', session], fault='read-only')
        no_storage(shown, reads=True)
        assert projection(shown, 'SHOW ') == wanted and contents(database) == before, shown
        note('maximum_ascii_identifiers_escaped_binding_and_option_reordering')

    if options.section in ('state', 'all'):
        database = new_database('unprovisioned-save')
        unprovisioned = run(database, cli_args('save', session='not-provisioned', text='hello'))
        no_storage(unprovisioned, reads=True)
        assert 'SAVED ' not in unprovisioned['stdout'] and unprovisioned['diagnostics'], unprovisioned
        assert any('missing session fence state' in item for item in unprovisioned['diagnostics']), unprovisioned
        note('save_never_provisions_an_absent_session_namespace')

        database = new_database('presentation-failure')
        seed(database, 'setup', 'presentation-failure')
        display_source = project / 'src/nomo/session_display.es'
        original_display = display_source.read_bytes()
        try:
            # Deliberate test-only dependency substitution, not a natural input
            # counterexample or any change to repository product behavior.
            display_source.write_text('''module nomo.session_display;
import nomo.session_state.Projection;
public flow display(value: Projection) -> Result<string, string> {
    return Err("injected presentation failure");
}
''')
            arguments = cli_args('save', session='presentation-failure', text='hello')
            failed = run(database, arguments)
            assert failed['diagnostics'] == [] and 'SAVED ' not in failed['stdout'] and 'REFUSED ' not in failed['stdout'], failed
            assert 'STORED_DISPLAY_FAILED; do not retry: injected presentation failure' in failed['stdout'], failed
            assert failed['memory_mutations'] == 2 and failed['session_appends'] == 1, failed
            row, version, count = stored(database)
            assert row['phase'] == 'published' and row['snapshot']['history']['spent'] == 1 and version == 2 and count == 1
            before = contents(database)
            repeated = run(database, arguments)
            assert 'REFUSED session metadata already exists' in repeated['stdout'], repeated
            assert 'SAVED ' not in repeated['stdout'] and 'STORED_DISPLAY_FAILED' not in repeated['stdout'], repeated
            assert repeated['memory_mutations'] == repeated['session_appends'] == 0 and contents(database) == before
        finally:
            display_source.write_bytes(original_display)
        shown = run(database, cli_args('show', session='presentation-failure'), fault='read-only')
        no_storage(shown, reads=True)
        assert projection(shown, 'SHOW ') == expected('presentation-failure',
            [('user', 'input', '', 'hello'), ('assistant', 'final', '', 'stub: hello')], 1), shown
        assert contents(database) == before
        note('injected_presentation_failure_reports_committed_state_no_retry_or_duplicate_save')

        for fault in ('pending', 'append', 'publish'):
            database = new_database('uncertain-' + fault)
            session = 'uncertain-' + fault
            seed(database, 'setup', session)
            failed = run(database, cli_args('save', session=session, text='hello'), fault=fault)
            assert failed['fault_fired'] and 'SAVED ' not in failed['stdout'], failed
            before = contents(database)
            shown = run(database, cli_args('show', session=session), fault='read-only')
            no_storage(shown, reads=True)
            if fault != 'publish':
                assert 'REFUSED pending save' in shown['stdout'] and 'SHOW ' not in shown['stdout'], shown
            else:
                wanted = expected(session, [('user', 'input', '', 'hello'), ('assistant', 'final', '', 'stub: hello')], 1)
                assert projection(shown, 'SHOW ') == wanted, shown
            assert contents(database) == before
            note('uncertain_' + fault + '_never_claimed_saved_and_read_only_show')

        database = new_database('show-refusals')
        seed(database, 'setup', 'stored-id')
        seed(database, 'save', 'stored-id')
        before = contents(database)
        binding = 'synthetic-binding-not-authority'
        cases = [cli_args('show', session='missing-id', binding=binding),
                 cli_args('show', session='stored-id', save='wrong-save', binding=binding),
                 cli_args('show', session='stored-id', binding='wrong-binding')]
        for index, arguments in enumerate(cases):
            shown = run(database, arguments, fault='read-only')
            no_storage(shown, reads=True)
            assert 'SHOW ' not in shown['stdout'] and shown['stdout'].startswith('REFUSED '), shown
            assert contents(database) == before
            note('show_independent_identity_binding_refusal_' + str(index))
        lowered = run(database, cli_args('show', session='stored-id', binding=binding, steps=1, budget=1), fault='read-only')
        no_storage(lowered, reads=True)
        lower_projection = projection(lowered, 'SHOW ')
        assert lower_projection['history']['spent'] == 3 and lower_projection['history']['stopped'], lowered
        assert lower_projection['caps']['steps'] == lower_projection['caps']['turn_steps'] == 1, lowered
        assert lower_projection['original_caps']['steps'] == 16 and contents(database) == before
        note('show_lower_caps_never_refunds_spent_or_mutates_saved_state')

        for corrupted in ('memory', 'session'):
            database = new_database('corrupt-' + corrupted)
            seed(database, 'setup', 'corrupt-id')
            seed(database, 'save', 'corrupt-id')
            with sqlite3.connect(database / (corrupted + '.sqlite3')) as connection:
                connection.execute('UPDATE memory_entries SET value_json=?' if corrupted == 'memory'
                                   else 'UPDATE session_messages SET payload_json=?', ('not-json',))
            before = contents(database)
            shown = run(database, cli_args('show', session='corrupt-id', binding=binding), fault='read-only')
            no_storage(shown, reads=True)
            assert 'SHOW ' not in shown['stdout'] and (shown['diagnostics'] or shown['stdout'].startswith('REFUSED ')), shown
            assert contents(database) == before
            note('show_corrupt_' + corrupted + '_refuses_without_write_or_fallback')

        database = new_database('other-mode')
        seed(database, 'setup', 'model-state', mode='text-model')
        seed(database, 'save', 'model-state', mode='text-model')
        shown = run(database, cli_args('show', session='model-state', binding=binding), fault='read-only')
        no_storage(shown, reads=True)
        assert 'REFUSED session mode mismatch' in shown['stdout'], shown
        note('show_stub_mode_is_independent_not_inferred_from_storage')

        for name, supplied, bodies in (
            ('controls', None, ['same', '', '"\\\n\r\t\x00\x1b\x7f雪😀\u202e\u2028']),
            ('maximum-unicode', 'maximum', ['😀' * 8192]),
            ('explicit-recovery', 'recovery', ['historical data only']),
        ):
            database = new_database('display-' + name)
            session = 'display-' + name
            if supplied in ('maximum', 'recovery'):
                recovery = supplied == 'recovery'
                supplied = deepcopy(snapshot())
                supplied[1]['history'][1].update(events=[event()], spent=0, stopped=not recovery)
                supplied[1].update(references=[reference()], operations=[], lifecycle='recovery-required' if recovery else 'stopped')
            seed(database, 'setup', session, bodies=bodies, supplied=supplied)
            seed(database, 'save', session, bodies=bodies, supplied=supplied)
            before = contents(database)
            shown = run(database, cli_args('show', session=session, binding=binding, steps=16, budget=16), fault='read-only')
            no_storage(shown, reads=True)
            display = projection(shown, 'SHOW ')
            assert [record['text'] for record in display['history']['events']] == bodies, shown
            assert display['history']['characters'] == sum(len(event['name']) + len(event['text']) for event in display['history']['events']), shown
            if name == 'explicit-recovery':
                assert display['disposition'] == 'recovery-required' and display['history']['stopped'], shown
                assert display['operations'] == [] and display['history']['spent'] == 0, shown
            assert len(shown['stdout'].splitlines()) == 1 and contents(database) == before
            note('show_' + name + '_bounded_ascii_json_preserves_payload')

    assert {name: digest(ROOT / name) for name in protected} == original
    note('root_default_entry_config_locks_validator_unchanged')
    print('PASS session CLI cases ' + str(len(passed)), flush=True)


if __name__ == '__main__':
    main()
