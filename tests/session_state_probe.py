#!/usr/bin/env python3
"""SESSION-001A: typed synthetic data only; validation is executed by Etas."""
from copy import deepcopy
from contextlib import nullcontext
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from normal_graph_identity import digest, verify_cli

ROOT = Path(__file__).resolve().parent.parent


def record(type_name, **fields):
    return (type_name, fields)


def render(value):
    if isinstance(value, tuple):
        kind, fields = value
        return kind + ' { ' + ', '.join(k + ' = ' + render(v) for k, v in fields.items()) + ' }'
    if isinstance(value, list):
        return '[' + ', '.join(map(render, value)) + ']'
    return json.dumps(value, ensure_ascii=False)


def event(role='user', kind='input', name='', text='hello'):
    return record('Event', role=role, kind=kind, name=name, text=text)


def reference(operation='', phase=''):
    return record('Reference', operation=operation, phase=phase)


def caps(mode='stub', steps=16):
    return record('Caps', steps=steps, turn_steps=16, attempts=4 if mode == 'text-model' else 0,
                  tokens=8192 if mode == 'text-model' else 0, scan_bytes=8192 if mode == 'scripted-read' else 0)


def snapshot(mode='stub'):
    model = mode == 'text-model'
    events = [event(), event('model', 'text' if model else 'request', 'qwen' if model else 'echo', ''),
              event('assistant' if model else 'tool', 'final' if model else 'complete', '' if model else 'echo', 'OUTCOME')]
    return record('Snapshot', format=1, session_id='synthetic-session', generation=7, mode=mode,
                  binding='synthetic-binding-not-authority', lifecycle='active',
                  history=record('State', events=events, characters=sum(len(e[1]['name']) + len(e[1]['text']) for e in events),
                                 spent=1 if model else 3, stopped=False),
                  references=[reference(), reference('op1', 'request'), reference('op1', 'outcome')],
                  operations=[record('Operation', id='op1', status='completed', attempts=1 if model else 0,
                                     tokens=2048 if model else 0, scan_bytes=4096 if mode == 'scripted-read' else 0)],
                  original_caps=caps(mode), current_caps=caps(mode),
                  ledger=record('Ledger', attempts=1 if model else 0, tokens=2048 if model else 0,
                                scan_bytes=4096 if mode == 'scripted-read' else 0, step_unit='steps',
                                attempt_unit='attempts', token_unit='total-input-output-tokens', scan_unit='bytes'))


def request(saved):
    s = saved[1]
    return record('Request', session_id=s['session_id'], mode=s['mode'], binding=s['binding'], caps=deepcopy(s['current_caps']))


def set_field(value, path, replacement):
    for key in path[:-1]:
        value = value[key] if isinstance(value, list) else value[1][key]
    if isinstance(value, list):
        value[path[-1]] = replacement
    else:
        value[1][path[-1]] = replacement


def cases():
    result = []

    def add(name, saved=None, changes=(), expected='refused', stopped=False, req=None, projected_caps=None):
        saved = deepcopy(saved or snapshot())
        req = deepcopy(req or request(saved))
        for path, value in changes:
            set_field(saved, path.split('.') if isinstance(path, str) else path, value)
        result.append((name, saved, req, expected, stopped, projected_caps or req[1]['caps']))

    for mode in ['stub', 'text-model', 'scripted-read']:
        s = snapshot(mode)
        add('valid_' + mode, s, expected='validated')
        add('stopped_' + mode, s, [('lifecycle', 'stopped'), ('history.stopped', True)], 'validated', True)
        for status in ['pending', 'unknown']:
            pending = deepcopy(s)
            pending[1]['history'][1]['events'].pop()
            pending[1]['references'].pop()
            pending[1]['history'][1]['characters'] -= len('OUTCOME') + (0 if mode == 'text-model' else 4)
            pending[1]['operations'][0][1]['status'] = status
            add(status + '_' + mode, pending, expected='recovery-required', stopped=True)
        lower = request(s)
        lower[1]['caps'][1]['steps'] = 1
        add('lower_steps_' + mode, s, expected='validated', stopped=True, req=lower)
        reduced = deepcopy(s)
        reduced[1]['current_caps'][1]['steps'] = 4
        add('higher_never_refills_' + mode, reduced, expected='validated', req=request(s), projected_caps=reduced[1]['current_caps'])
        add('exhausted_steps_' + mode, s, [('history.spent', 16 if mode != 'text-model' else 4),
                                          ('current_caps.steps', 16 if mode != 'text-model' else 1)],
            'validated' if mode != 'text-model' else 'refused', True)
    simple = snapshot()
    simple[1]['history'] = record('State', events=[], characters=0, spent=0, stopped=False)
    simple[1]['references'] = []
    simple[1]['operations'] = []
    add('empty_history', simple, expected='validated')
    reordered = snapshot()
    reordered[1]['current_caps'] = ('Caps', dict(reversed(list(reordered[1]['current_caps'][1].items()))))
    add('caps_named_fields_independent_of_construction_order', reordered, expected='validated')
    add('steps_not_event_count', simple, [('history.spent', 5)], 'validated')
    add('explicit_recovery_without_operations', simple, [('lifecycle', 'recovery-required')], 'recovery-required', True)
    for field, value in [('format', 0), ('format', 2), ('mode', 'other'), ('generation', -1), ('lifecycle', 'other'),
                         ('session_id', ''), ('session_id', 'x' * 129), ('session_id', 'x\n'), ('session_id', '世界'),
                         ('binding', ''), ('binding', 'x' * 129), ('binding', 'x\t'), ('history.spent', -1),
                         ('history.spent', 17), ('history.spent', 2147483647), ('history.characters', 8193),
                         ('history.characters', 2147483647), ('history.characters', 0), ('history.stopped', True),
                         ('lifecycle', 'stopped'), ('original_caps.steps', 0), ('original_caps.steps', 17),
                         ('original_caps.steps', -1), ('current_caps.steps', 17), ('original_caps.steps', 1),
                         ('ledger.attempts', -1), ('ledger.attempts', 2147483647), ('ledger.tokens', -1),
                         ('ledger.scan_bytes', -1), ('ledger.scan_bytes', 2147483647), ('ledger.step_unit', 'tokens'),
                         ('ledger.attempt_unit', 'steps'), ('ledger.token_unit', 'output-tokens'), ('ledger.scan_unit', 'characters')]:
        add('reject_' + field + '_' + repr(value), changes=[(field, value)])
    for field, value in [('mode', 'text-model'), ('session_id', 'wrong'), ('binding', 'wrong'), ('binding', ''),
                         ('binding', 'x' * 129), ('session_id', 'x\n'), ('caps.steps', 0)]:
        req = request(snapshot())
        set_field(req, field.split('.'), value)
        add('requested_' + field + '_' + repr(value), req=req)
    for size in [128, 129]:
        s = deepcopy(simple)
        s[1]['session_id'] = s[1]['binding'] = 'x' * size
        add('identifier_binding_boundary_' + str(size), s, expected='validated' if size == 128 else 'refused')
    for field, value in [('id', ''), ('id', 'x' * 129), ('id', '\n'), ('status', 'other'), ('status', 'unknown'),
                         ('attempts', 1), ('tokens', 2048), ('scan_bytes', 1), ('scan_bytes', -1)]:
        add('operation_' + field + '_' + repr(value), changes=[(('operations', 0, field), value)])
    for field, value in [('operation', 'missing'), ('operation', ''), ('operation', 'x' * 129), ('phase', 'other'), ('phase', 'outcome')]:
        add('reference_' + field + '_' + repr(value), changes=[(('references', 1, field), value)])
    add('missing_reference_array', changes=[('references', [])])
    add('duplicate_operation_id', changes=[('operations', snapshot()[1]['operations'] * 2)])
    add('maximum_generation_without_increment', changes=[('generation', 2147483647)], expected='validated')
    for value in [0, -1, 17, 2147483647]:
        add('turn_cap_' + str(value), changes=[('current_caps.turn_steps', value)])
    reduced = snapshot()
    reduced[1]['current_caps'][1]['turn_steps'] = 1
    add('higher_turn_cap_never_refills', reduced, expected='validated', req=request(snapshot()), projected_caps=reduced[1]['current_caps'])
    for size in [128, 129]:
        s = snapshot()
        s[1]['operations'][0][1]['id'] = 'x' * size
        for ref in s[1]['references'][1:]:
            ref[1]['operation'] = 'x' * size
        add('operation_identifier_boundary_' + str(size), s, expected='validated' if size == 128 else 'refused')
    for order, label in [([0, 2, 1], 'outcome_before_request'), ([0, 1, 1, 2], 'duplicate_request'),
                         ([0, 1, 2, 2], 'duplicate_outcome'), ([0, 1], 'completed_without_outcome')]:
        s = snapshot()
        s[1]['history'][1]['events'] = [s[1]['history'][1]['events'][i] for i in order]
        s[1]['references'] = [s[1]['references'][i] for i in order]
        s[1]['history'][1]['characters'] = sum(len(e[1]['name']) + len(e[1]['text']) for e in s[1]['history'][1]['events'])
        add(label, s)
    paired = snapshot()
    second = snapshot()
    second[1]['operations'][0][1]['id'] = 'op2'
    for ref in second[1]['references'][1:]:
        ref[1]['operation'] = 'op2'
    paired[1]['history'][1]['events'] += second[1]['history'][1]['events']
    paired[1]['history'][1]['characters'] *= 2
    paired[1]['history'][1]['spent'] = 6
    paired[1]['references'] += second[1]['references']
    paired[1]['operations'] += second[1]['operations']
    add('ordered_two_operations', paired, expected='validated')
    add('reversed_operation_order', paired, [('operations', list(reversed(paired[1]['operations'])))])
    add('outcome_tool_name_mismatch', changes=[(('history', 'events', 2, 'name'), 'else')])
    for field, value in [('role', 'other'), ('kind', 'other'), ('name', 'x' * 129), ('name', '\n')]:
        add('event_metadata_' + field, changes=[(('history', 'events', 1, field), value)])
    for total in [31, 32, 33]:
        for stopped in [False, True]:
            s = deepcopy(simple)
            s[1]['history'] = record('State', events=[event(text='')] * total, characters=0, spent=0, stopped=stopped)
            s[1]['references'] = [reference()] * total
            s[1]['lifecycle'] = 'stopped' if stopped else 'active'
            add('event_limit_' + str(total) + '_' + str(stopped), s,
                expected='validated' if total <= (32 if stopped else 31) else 'refused', stopped=stopped)
    for total in [8128, 8129, 8192, 8193]:
        for stopped in [False, True]:
            s = deepcopy(simple)
            s[1]['history'] = record('State', events=[event(text='x' * total)], characters=total, spent=0, stopped=stopped)
            s[1]['references'] = [reference()]
            s[1]['lifecycle'] = 'stopped' if stopped else 'active'
            add('content_limit_' + str(total) + '_' + str(stopped), s,
                expected='validated' if total <= (8192 if stopped else 8128) else 'refused', stopped=stopped)
    for total in [32, 33]:
        s = deepcopy(simple)
        s[1]['operations'] = [record('Operation', id='op' + str(i), status='unknown', attempts=0, tokens=0, scan_bytes=0) for i in range(total)]
        add('operation_limit_' + str(total), s, expected='recovery-required' if total == 32 else 'refused', stopped=True)
    for mode, field, values in [('text-model', 'attempts', [-1, 5, 2147483647]),
                               ('text-model', 'tokens', [-1, 8193, 2147483647]),
                               ('scripted-read', 'scan_bytes', [-1, 8193, 2147483647])]:
        for value in values:
            add(mode + '_counter_' + field + '_' + str(value), snapshot(mode), [('ledger.' + field, value)])
            add(mode + '_cap_' + field + '_' + str(value), snapshot(mode), [('original_caps.' + field, value)])
    for mode, field, value in [('text-model', 'attempts', 0), ('text-model', 'tokens', 2047), ('scripted-read', 'scan_bytes', 4095)]:
        req = request(snapshot(mode))
        req[1]['caps'][1][field] = value
        add('lower_' + field, snapshot(mode), expected='validated', stopped=True, req=req)
    add('model_step_mismatch', snapshot('text-model'), [('history.spent', 2)])
    add('model_token_mismatch', snapshot('text-model'), [('ledger.tokens', 2047)])
    add('model_operation_token_mismatch', snapshot('text-model'), [(('operations', 0, 'tokens'), 2047)])
    add('scan_operation_mismatch', snapshot('scripted-read'), [(('operations', 0, 'scan_bytes'), 4095)])
    add('scan_ledger_mismatch', snapshot('scripted-read'), [('ledger.scan_bytes', 8192)])
    add('spent_less_than_operation_evidence', changes=[('history.spent', 1)])
    # A reservation exists before scripted input validation: zero steps is real.
    preflight = snapshot('scripted-read')
    preflight[1]['history'] = record('State', events=[event('error', 'error', '', 'refused')], characters=7, spent=0, stopped=False)
    preflight[1]['references'] = [reference('op1', 'outcome')]
    add('scripted_preflight_retains_scan', preflight, expected='validated')
    unknown = deepcopy(preflight)
    unknown[1]['history'] = record('State', events=[], characters=0, spent=0, stopped=False)
    unknown[1]['references'] = []
    unknown[1]['operations'][0][1]['status'] = 'unknown'
    add('scripted_unknown_no_evidence_no_refund', unknown, expected='recovery-required', stopped=True)
    for mode, total in [('text-model', 4), ('scripted-read', 2)]:
        s = snapshot(mode)
        s[1]['history'] = record('State', events=[], characters=0, spent=total if mode == 'text-model' else 0, stopped=False)
        s[1]['references'] = []
        s[1]['operations'] = [record('Operation', id='op' + str(i), status='unknown', attempts=1 if mode == 'text-model' else 0,
                                    tokens=2048 if mode == 'text-model' else 0, scan_bytes=4096 if mode == 'scripted-read' else 0) for i in range(total)]
        s[1]['ledger'][1].update(attempts=total if mode == 'text-model' else 0,
                                tokens=8192 if mode == 'text-model' else 0, scan_bytes=8192 if mode == 'scripted-read' else 0)
        add('exact_reservation_cap_' + mode, s, expected='recovery-required', stopped=True)
    add('diagnostic_does_not_echo_sensitive_sentinel', changes=[('session_id', 'SYNTHETIC_SECRET_SENTINEL\n')])
    add('free_text_is_data_not_secret_detection', simple, [('history.events', [event(text='SYNTHETIC_SECRET_SENTINEL')]),
        ('history.characters', len('SYNTHETIC_SECRET_SENTINEL')), ('references', [reference()])], 'validated')
    return result


IMPORTS = '''module nomo.session_fixture;
import std.io.println;
import std.text.{len, contains};
import nomo.core.conversation.{Event, State};
import nomo.session.session_state.{Caps, Ledger, Operation, Reference, Snapshot, Request, Projection, validate};
'''


def fixture(all_cases):
    flows = []
    for i, (name, saved, req, expected, stopped, projected_caps) in enumerate(all_cases):
        good = f'''projection.disposition == {render(expected)} && projection.history.events == saved.history.events &&
            projection.history.characters == saved.history.characters && projection.history.spent == saved.history.spent &&
            projection.history.stopped == {render(stopped)} && projection.ledger == saved.ledger &&
            projection.operations == saved.operations && projection.references == saved.references &&
            projection.original_caps == saved.original_caps &&
            projection.caps.steps == expected_caps.steps && projection.caps.turn_steps == expected_caps.turn_steps &&
            projection.caps.attempts == expected_caps.attempts && projection.caps.tokens == expected_caps.tokens &&
            projection.caps.scan_bytes == expected_caps.scan_bytes &&
            projection.session_id == saved.session_id && projection.generation == saved.generation &&
            projection.mode == saved.mode && projection.binding == saved.binding'''
        flows.append(f'''flow case_{i}() -> bool {{
    let saved = {render(saved)};
    let original = saved;
    let requested = {render(req)};
    let expected_caps = {render(projected_caps)};
    let first = validate(saved, requested);
    let second = validate(saved, requested);
    if first != second || saved != original {{ return false; }}
    match first {{
        Ok(projection) => {{ return {good if expected != 'refused' else 'false'}; }}
        Err(message) => {{ return {'len(message) > 0 && len(message) <= 64 && !contains(message, "SYNTHETIC_SECRET_SENTINEL")' if expected == 'refused' else 'false'}; }}
    }}
}}
''')
    main = 'public flow main(args: Array<string>) -> i32 {\nvar failed: i32 = 0;\n'
    for i in range(len(all_cases)):
        main += f'if case_{i}() {{ println("PASS {i}"); }} else {{ println("FAIL {i}"); failed = failed + 1; }}\n'
    return IMPORTS + '\n'.join(flows) + 'public flow pure_probe() -> bool { return case_0(); }\n' + main + 'return failed;\n}\n'


def main():
    verify_cli()
    originals = {p: digest(ROOT / p) for p in ['etas.toml', 'etas.lock', 'compose.yaml', 'patches/etas-003/Cargo.lock']}
    all_cases = cases()
    evidence_parent = os.environ.get('NOMO_TEST_EVIDENCE')
    directory_context = (nullcontext(tempfile.mkdtemp(prefix='nomo-session001a-', dir=evidence_parent))
                         if evidence_parent else tempfile.TemporaryDirectory(prefix='nomo-session001a-'))
    with directory_context as directory:
        project = Path(directory)
        if evidence_parent:
            print('EVIDENCE ' + str(project), flush=True)
        shutil.copytree(ROOT / 'src', project / 'src')
        shutil.copyfile(ROOT / 'etas.lock', project / 'etas.lock')
        (project / 'etas.toml').write_text((ROOT / 'etas.toml').read_text().replace('module = "nomo.main"', 'module = "nomo.session_fixture"'))
        source = project / 'src/nomo/session_fixture.es'
        observations = []
        def run(*args, timeout=60):
            command = ['etas', *args]
            if not evidence_parent:
                return subprocess.run(command, capture_output=True, text=True, timeout=timeout)
            retained = project / 'generated-inputs' / (digest(source) + '.es')
            retained.parent.mkdir(exist_ok=True)
            if not retained.exists():
                shutil.copyfile(source, retained)
            assert digest(retained) == digest(source), 'generated-source evidence collision'
            command_directory = project / 'commands' / str(len(observations)).zfill(3)
            command_directory.mkdir(parents=True)
            item = {'command': command, 'timeout_seconds': timeout, 'status': 'running',
                    'input': {'path': str(source.relative_to(project)), 'sha256': digest(retained),
                              'retained': str(retained.relative_to(project))}}
            observations.append(item)
            output = project / 'results.json'
            output.write_text(json.dumps(observations, indent=2) + '\n')
            stdout, stderr, exit_code = b'', b'', None
            try:
                result = subprocess.run(command, capture_output=True, timeout=timeout)
                stdout, stderr, exit_code = result.stdout, result.stderr, result.returncode
                return subprocess.CompletedProcess(command, exit_code, stdout.decode(), stderr.decode())
            except subprocess.TimeoutExpired as error:
                stdout, stderr = error.stdout or b'', error.stderr or b''
                item['timed_out'] = True
                raise
            finally:
                (command_directory / 'stdout.bin').write_bytes(stdout)
                (command_directory / 'stderr.bin').write_bytes(stderr)
                item.update(status='observed', exit=exit_code,
                            stdout=stdout.decode('utf-8', errors='replace'),
                            stderr=stderr.decode('utf-8', errors='replace'),
                            stdout_retained=str((command_directory / 'stdout.bin').relative_to(project)),
                            stderr_retained=str((command_directory / 'stderr.bin').relative_to(project)))
                output.write_text(json.dumps(observations, indent=2) + '\n')
        for offset in range(0, len(all_cases), 12):
            batch = all_cases[offset:offset + 12]
            source.write_text(fixture(batch))
            checked = run('check', '--all', str(project))
            assert checked.returncode == 0, (checked.returncode, checked.stdout, checked.stderr)
            if offset == 0:
                print('PASS session_check_all', flush=True)
                effects = run('effects', str(project), '--flow', 'pure_probe')
                assert effects.returncode == 0, effects.stdout + effects.stderr
                print(effects.stdout, flush=True)
                assert 'requested actions: []' in effects.stdout, effects.stdout
                print('PASS session_validator_no_host_actions', flush=True)
            result = run('run', str(project), '--allow-effects', timeout=120)
            for i, case in enumerate(batch):
                assert f'PASS {i}\n' in result.stdout, (case[0], result.returncode, result.stdout, result.stderr)
                print('PASS ' + case[0], flush=True)
            assert result.returncode == 0 and 'FAIL' not in result.stdout, result.stdout + result.stderr
        # Typed field allowlist: unsupported authority/private fields cannot enter.
        for field in ['credential', 'approval_handle', 'provider_private_payload', 'raw_checkpoint', 'backend_version']:
            s = snapshot()
            s[1][field] = 'SYNTHETIC_SECRET_SENTINEL'
            source.write_text(IMPORTS + 'public flow main(args: Array<string>) -> i32 { let saved = ' + render(s) + '; return 0; }\n')
            rejected = run('check', str(project))
            assert rejected.returncode != 0 and 'type::Mismatch' in rejected.stdout + rejected.stderr, rejected.stdout + rejected.stderr
            assert 'SYNTHETIC_SECRET_SENTINEL' not in result.stdout + result.stderr
            print('PASS excluded_field_' + field, flush=True)
    assert all(digest(ROOT / p) == before for p, before in originals.items())
    print(f'PASS {len(all_cases)} typed runtime cases; 5 excluded-field checks; hashes preserved', flush=True)


if __name__ == '__main__':
    main()
