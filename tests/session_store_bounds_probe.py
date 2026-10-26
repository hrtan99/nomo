#!/usr/bin/env python3
"""Real isolated storage bounds/reload negatives; fixture data, not product logic."""
from copy import deepcopy
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from session_state_probe import caps, event, record, reference, render, snapshot, set_field
from session_store_probe import CLI, EVIDENCE, GRAPH, ROOT, digest, expected, fixture_source, materialize, retain_input


def change(source, before, after):
    assert source.count(before) == 1, before
    return source.replace(before, after)


def empty_snapshot(mode, count=0, stopped=False):
    saved = snapshot(mode)
    saved[1]['history'] = record('State', events=[event(text='')] * count, characters=0, spent=0, stopped=stopped)
    saved[1]['references'] = [reference()] * count
    saved[1]['operations'] = []
    saved[1]['lifecycle'] = 'stopped' if stopped else 'active'
    for name in ['attempts', 'tokens', 'scan_bytes']:
        saved[1]['ledger'][1][name] = 0
    return saved


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', action='append', help='Run only the named case; repeatable.')
    parser.add_argument('--negative-only', action='store_true', help='Run only actual reload refusal cases.')
    parser.add_argument('--positive-only', action='store_true', help='Run only actual save/reload successes.')
    options = parser.parse_args()
    assert not (options.negative_only and options.positive_only), 'Choose one case group.'
    assert digest(CLI) == json.loads((GRAPH / 'binary.json').read_text())['sha256']
    protected = {name: digest(ROOT / name) for name in ['etas.toml', 'etas.lock', 'src/nomo/session/session_state.es']}
    evidence = Path(tempfile.mkdtemp(prefix='session-store-bounds-', dir=EVIDENCE))
    print('EVIDENCE ' + str(evidence), flush=True)
    results = []
    total = 0

    def case(name, mode, saved, bodies, refusal=None, request_caps=None, request_binding=None,
             request_mode=None, source_changes=(), disposition='validated', stopped=None):
        nonlocal total
        if options.only and name not in options.only:
            return
        if options.negative_only and refusal is None:
            return
        if options.positive_only and refusal is not None:
            return
        project = evidence / name
        source = materialize(project)
        fixture = fixture_source(mode, saved)
        for before, after in source_changes:
            fixture = change(fixture, before, after)
        old_request = 'let requested = Request { session_id = id, mode = saved.mode, binding = saved.binding, caps = saved.current_caps };'
        new_request = 'let requested = Request { session_id = id, mode = ' + (render(request_mode) if request_mode else 'saved.mode') + ', binding = ' + (render(request_binding) if request_binding else 'saved.binding') + ', caps = ' + (render(request_caps) if request_caps else 'saved.current_caps') + ' };'
        fixture = change(fixture, old_request, new_request)
        source.write_text(fixture)
        database = project / 'store'
        database.mkdir()
        env = dict(os.environ, ETAS_HOST_MEMORY='sqlite:' + str(database / 'memory.sqlite3'),
                   ETAS_HOST_SESSION='sqlite:' + str(database / 'session.sqlite3'))
        session_id, save_id = name, 'save-one'
        payload = json.dumps(['nomo-session-bundle-v1', session_id, save_id, *bodies], ensure_ascii=False)

        def invoke(action, *extra):
            command = [str(CLI), 'run', str(project), '--allow-effects', '--args', action, session_id, save_id, payload, *extra]
            # Each case has its own immutable entry/manifest/product copy;
            # nothing is regenerated over evidence from an earlier invocation.
            inputs = retain_input(project, source)
            run = subprocess.run(command, text=True, capture_output=True, env=env, timeout=90)
            results.append({'case': name, 'command': command, 'exit': run.returncode,
                            'stdout': run.stdout, 'stderr': run.stderr, 'inputs': inputs,
                            'product_sources': str(project / 'product-sources.json'),
                            'storage_configuration': {'ETAS_HOST_MEMORY': env['ETAS_HOST_MEMORY'],
                                                      'ETAS_HOST_SESSION': env['ETAS_HOST_SESSION']}})
            (evidence / 'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
            return run

        setup = invoke('setup')
        assert setup.returncode == 0 and 'SETUP_EMPTY' in setup.stdout, (name, setup.stdout, setup.stderr)
        if refusal:
            # Seed deliberately malformed typed data through the public Etas
            # fixture path, then let the actual product reload reject it.
            for action, extra in [('seed-body', payload), ('seed-metadata', 'published')]:
                seed = invoke(action, extra)
                assert seed.returncode == 0 and 'SEEDED_' in seed.stdout, (name, seed.stdout, seed.stderr)
            loaded = invoke('load')
            # CLI success describes interpreter execution; a source i32 result
            # is not the process exit status. Assert the product refusal itself.
            assert loaded.returncode == 0 and ('REFUSED ' + refusal) in loaded.stdout, (name, loaded.stdout, loaded.stderr)
        else:
            wanted = expected(mode, session_id, bodies, saved)
            wanted['disposition'] = disposition
            if stopped is not None:
                wanted['history']['stopped'] = stopped
            if request_caps:
                wanted['caps'] = {key: min(value, request_caps[1][key]) for key, value in wanted['caps'].items()}
            for action in ['save', 'load', 'load']:
                run = invoke(action)
                assert run.returncode == 0 and json.loads(run.stdout) == wanted, (name, action, run.stdout, run.stderr, wanted)
            # A second save cannot turn the absolute saved ledgers into another charge.
            repeated = invoke('save')
            assert 'REFUSED session metadata already exists' in repeated.stdout, (name, repeated.stdout, repeated.stderr)
        total += 1
        print('PASS ' + name, flush=True)

    for mode in ['stub', 'text-model', 'scripted-read']:
        case(mode + '-zero', mode, empty_snapshot(mode), [])
        case(mode + '-32-stopped', mode, empty_snapshot(mode, 32, True), [''] * 32, stopped=True)
        stopped = snapshot(mode)
        stopped[1]['lifecycle'] = 'stopped'
        stopped[1]['history'][1]['stopped'] = True
        case(mode + '-stopped', mode, stopped, ['prior', '', 'outcome'], stopped=True)
        for status in ['pending', 'unknown']:
            pending = snapshot(mode)
            pending[1]['history'][1]['events'].pop()
            pending[1]['references'].pop()
            pending[1]['operations'][0][1]['status'] = status
            case(mode + '-' + status, mode, pending, ['prior', 'request'], disposition='recovery-required', stopped=True)
        case(mode + '-lower-request-cap', mode, snapshot(mode), ['prior', '', 'outcome'], request_caps=caps(mode, 1), stopped=True)
        reduced = snapshot(mode)
        reduced[1]['current_caps'][1]['steps'] = 4
        case(mode + '-higher-request-cannot-refill', mode, reduced, ['prior', '', 'outcome'], request_caps=caps(mode, 16))
    case('stopped-8192-characters', 'stub', empty_snapshot('stub', 1, True), ['🚀' * 8192], stopped=True)
    case('active-8128-headroom', 'stub', empty_snapshot('stub', 1), ['x' * 8128])
    model_caps = caps('text-model')
    model_caps[1]['attempts'] = 0
    model_caps[1]['tokens'] = 0
    case('model-reservations-above-lowered-cap', 'text-model', snapshot('text-model'), ['prior', '', 'outcome'],
         request_caps=model_caps, stopped=True)
    scan_caps = caps('scripted-read')
    scan_caps[1]['scan_bytes'] = 4095
    case('scan-reservation-above-lowered-cap', 'scripted-read', snapshot('scripted-read'), ['prior', '', 'outcome'],
         request_caps=scan_caps, stopped=True)

    normal = snapshot('stub')
    bodies = ['prior', '', 'outcome']
    case('wrong-request-binding', 'stub', normal, bodies, refusal='missing or mismatched binding evidence', request_binding='wrong-binding')
    case('wrong-request-mode', 'stub', normal, bodies, refusal='session mode mismatch', request_mode='text-model')
    case('invalid-request-caps', 'stub', normal, bodies, refusal='invalid mode-specific caps', request_caps=caps('stub', 0))
    case('outer-format', 'stub', normal, bodies, refusal='metadata identity mismatch', source_changes=[
        ('let row = Record { format = 1, phase = args[4]', 'let row = Record { format = 2, phase = args[4]')])
    case('nonempty-metadata-body', 'stub', normal, bodies, refusal='metadata contains duplicate event body', source_changes=[
        ('session_key = prepared.session_key, snapshot = prepared.snapshot',
         'session_key = prepared.session_key, snapshot = with_events(prepared.snapshot, saved.history.events)')])
    case('cached-character-mismatch', 'stub', normal, bodies, refusal='cached character count mismatch', source_changes=[
        ('history = State { events = events, characters = characters, spent = state.history.spent',
         'history = State { events = events, characters = characters + 1, spent = state.history.spent')])
    for name, path, value, refusal in [
        ('snapshot-format', ['format'], 2, 'unsupported session format'),
        ('negative-generation', ['generation'], -1, 'invalid logical generation'),
        ('invalid-binding', ['binding'], 'x' * 129, 'missing or mismatched binding evidence'),
        ('current-cap-limit', ['current_caps', 'steps'], 17, 'invalid mode-specific caps'),
        ('current-cap-above-original', ['original_caps', 'steps'], 2, 'saved caps exceed original caps'),
        ('invalid-spent', ['history', 'spent'], 17, 'invalid saved counters'),
        ('wrong-budget-unit', ['ledger', 'step_unit'], 'tokens', 'invalid budget units'),
        ('cross-mode-reservation', ['ledger', 'attempts'], 1, 'invalid saved counters'),
        ('dangling-reference', ['references', 1, 'operation'], 'missing', 'dangling operation reference'),
        ('unknown-operation-status', ['operations', 0, 'status'], 'other', 'invalid operation status'),
        ('tool-name-mismatch', ['history', 'events', 2, 'name'], 'different', 'tool outcome does not match request'),
        ('lifecycle-stopped-mismatch', ['history', 'stopped'], True, 'lifecycle and stopped flag disagree'),
        ('reference-count-mismatch', ['references'], [], 'bundle descriptor count mismatch'),
        ('operation-count-limit', ['operations'], normal[1]['operations'] * 33, 'bundle descriptor count mismatch'),
    ]:
        malformed = deepcopy(normal)
        set_field(malformed, path, value)
        case(name, 'stub', malformed, bodies, refusal=refusal)
    for mode, path, value, refusal in [
        ('text-model', ['ledger', 'tokens'], 2047, 'model reservation mismatch'),
        ('text-model', ['history', 'spent'], 2, 'model reservation mismatch'),
        ('scripted-read', ['operations', 0, 'scan_bytes'], 4095, 'invalid scan reservation'),
        ('scripted-read', ['ledger', 'scan_bytes'], 8192, 'operation ledger mismatch'),
    ]:
        malformed = snapshot(mode)
        set_field(malformed, path, value)
        case(mode + '-' + '-'.join(map(str, path)) + '-reservation', mode, malformed, bodies, refusal=refusal)
    assert total > 0, 'No requested case matched.'
    assert all(digest(ROOT / name) == value for name, value in protected.items())
    (evidence / 'protected-hashes.json').write_text(json.dumps(protected, indent=2))
    print(f'PASS {total} actual SQLite boundary/reload cases; source hashes preserved; repeated read-only loads never change ledgers', flush=True)


if __name__ == '__main__':
    main()
