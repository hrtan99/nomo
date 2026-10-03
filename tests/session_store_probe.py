#!/usr/bin/env python3
"""Real two-process storage checks. Python supplies fixtures, never product policy."""
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

from session_state_probe import snapshot, render

ROOT = Path(__file__).resolve().parent.parent
GRAPH = Path(os.environ.get('SESSION_STORE_GRAPH', '/validation'))
CLI = Path(os.environ.get('ETAS', str(GRAPH / 'target/debug/etas')))
EVIDENCE = Path(os.environ.get('NOMO_TEST_EVIDENCE', str(GRAPH)))
SHARED = ['conversation.es', 'session_state.es', 'text.es', 'loop.es', 'stub.es']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def retain_input(project, source):
    """Keep every generated entry/config, not only the last overwritten fixture."""
    directory = project / 'inputs'
    directory.mkdir(exist_ok=True)
    result = {}
    for path in (source, project / 'etas.toml'):
        fingerprint = digest(path)
        retained = directory / (fingerprint + path.suffix)
        if not retained.exists():
            shutil.copyfile(path, retained)
        assert digest(retained) == fingerprint
        result[str(path.relative_to(project))] = {
            'sha256': fingerprint, 'retained': str(retained.relative_to(project))}
    return result


def materialize(project):
    target = project / 'src/nomo'
    target.mkdir(parents=True)
    for path in (ROOT / 'packages/session-store/src/nomo').glob('*.es'):
        shutil.copyfile(path, target / path.name)
    for name in SHARED:
        source = ROOT / 'src/nomo' / name
        shutil.copyfile(source, target / name)
        assert digest(source) == digest(target / name)
    (project / 'etas.toml').write_text('''[package]
name = "nomo-storage-fixture"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[[bin]]
name = "fixture"
module = "app.main"
flow = "main"
''')
    fixture = project / 'src/app'
    fixture.mkdir()
    (project / 'product-sources.json').write_text(json.dumps({
        str(path.relative_to(project)): digest(path) for path in target.glob('*.es')
    }, indent=2))
    return fixture / 'main.es'


def fixture_source(mode, supplied=None):
    s = deepcopy(supplied or snapshot(mode))
    s[1]['session_id'] = '__SESSION_ID__'
    # Typed metadata is synthetic; bodies arrive as lossless JSON through codec.
    expressions = render(s).replace('"__SESSION_ID__"', 'id')
    return '''module app.main;
import std.io.println;
import std.collections.len as count;
import std.text.len;
import std.json.{JsonValue, stringify, parse};
import nomo.conversation.{Event, State};
import nomo.session_state.{Caps, Ledger, Operation, Reference, Snapshot, Request, Projection};
import nomo.store_record.{with_events, session_key};
import nomo.bundle_codec.{decode, encode};
import nomo.session_store.{save, reload};
import nomo.store_record.{pending, published, Record};
import nomo.metadata_store.write;
import nomo.history_store.append;
import std.memory.Missing;

flow fixture(id: string, json: string) -> Snapshot {
    let original = ''' + expressions + ''';
    let body = match decode(json) { Ok(value) => value, Err(_) => { abort("bad fixture input"); } };
    if count(body.bodies) != count(original.history.events) { abort("bad fixture count"); }
    var events: Array<Event> = [];
    var characters: usize = 0;
    var index: usize = 0;
    for event in original.history.events limit Iterations(32) {
        let text = body.bodies[index];
        events = events.push(Event { role = event.role, kind = event.kind, name = event.name, text = text });
        characters = characters + len(event.name) + len(text);
        index = index + 1;
    }
    let state = with_events(original, events);
    return Snapshot { format = state.format, session_id = state.session_id, generation = state.generation,
        mode = state.mode, binding = state.binding, lifecycle = state.lifecycle,
        history = State { events = events, characters = characters, spent = state.history.spent, stopped = state.history.stopped },
        references = state.references, operations = state.operations, original_caps = state.original_caps,
        current_caps = state.current_caps, ledger = state.ledger };
}

public flow main(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    let id = args[1];
    let save_id = args[2];
    if args[0] == "setup" {
        let history = Conversation.load(SessionConfig.continue_or_new(session_key(id, save_id)));
        if count(history.messages) != 0 { abort("setup history is not empty"); }
        println("SETUP_EMPTY");
        return 0;
    }
    let saved = fixture(id, args[3]);
    let requested = Request { session_id = id, mode = saved.mode, binding = saved.binding, caps = saved.current_caps };
    if args[0] == "seed-raw" || args[0] == "seed-two" {
        let payload = match parse(args[4]) { Ok(value) => value, Err(_) => { abort("bad seeded JSON"); } };
        let first = Message.with_session(Message.new(payload), SessionConfig.continue_or_new(session_key(id, save_id)));
        if args[0] == "seed-two" {
            let second = Message.with_session(Message.new(payload), SessionConfig.continue_or_new(session_key(id, save_id)));
        }
        println("SEEDED_RAW");
        return 0;
    }
    if args[0] == "seed-body" {
        let body = match decode(args[4]) { Ok(value) => value, Err(_) => { abort("bad seeded bundle"); } };
        match append(session_key(id, save_id), body) { Ok(_) => { println("SEEDED_BODY"); }, Err(error) => { println("REFUSED " + error); } }
        return 0;
    }
    if args[0] == "seed-metadata" {
        let prepared = pending(saved, save_id);
        let row = Record { format = 1, phase = args[4], save_id = prepared.save_id,
            session_key = prepared.session_key, snapshot = prepared.snapshot };
        match write(row, Missing) { Ok(_) => { println("SEEDED_METADATA"); }, Err(error) => { println("REFUSED " + error); } }
        return 0;
    }
    let result = if args[0] == "save" { save(saved, requested, save_id) } else { reload(requested, save_id) };
    match result {
        Err(error) => { println("REFUSED " + error); return 1; }
        Ok(value) => {
            let message = Message.new(value);
            let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
            let converted = match conversion { Some(item) => item.body, None => { abort("fixture output cast"); } };
            let json = match stringify(converted) { Ok(item) => item, Err(_) => { abort("fixture output JSON"); } };
            println(json);
            return 0;
        }
    }
}
'''


def plain(value):
    if isinstance(value, tuple):
        return {k: plain(v) for k, v in value[1].items()}
    if isinstance(value, list):
        return list(map(plain, value))
    return value


def expected(mode, session_id, bodies, supplied=None):
    s = plain(supplied or snapshot(mode))
    s['session_id'] = session_id
    for event, text in zip(s['history']['events'], bodies):
        event['text'] = text
    s['history']['characters'] = sum(len(e['name']) + len(e['text']) for e in s['history']['events'])
    return {k: s[k] for k in ['session_id', 'generation', 'mode', 'binding', 'history', 'references', 'operations', 'original_caps', 'ledger']} | {
        'disposition': 'validated', 'caps': s['current_caps']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--negative-only', action='store_true')
    opts = parser.parse_args()
    assert digest(CLI) == json.loads((GRAPH / 'binary.json').read_text())['sha256']
    project = Path(tempfile.mkdtemp(prefix='session-store-cases-', dir=EVIDENCE))
    print('EVIDENCE ' + str(project), flush=True)
    source = materialize(project)
    results = []

    def command(args, env=None, timeout=40):
        inputs = retain_input(project, source)
        result = subprocess.run([str(CLI), *args], text=True, capture_output=True, env=env, timeout=timeout)
        results.append({'command': args, 'exit': result.returncode, 'stdout': result.stdout,
                        'stderr': result.stderr, 'inputs': inputs,
                        'storage_environment': {key: (env or {}).get(key) for key in ('ETAS_HOST_MEMORY', 'ETAS_HOST_SESSION')},
                        'runtime_profile': 'no named profile; retained manifest and explicit --allow-effects CLI fixture'})
        (project / 'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
        return result

    source.write_text(fixture_source('stub'))
    checked = command(['check', '--all', str(project)])
    assert checked.returncode == 0, checked.stdout + checked.stderr
    print('PASS newer_graph_product_and_fixture_check', flush=True)
    if opts.check_only:
        return
    if opts.negative_only:
        negative_cases(project, source, command)
        return
    for mode in ['stub', 'text-model', 'scripted-read']:
        source.write_text(fixture_source(mode))
        database = project / mode
        database.mkdir()
        env = dict(os.environ, ETAS_HOST_MEMORY='sqlite:' + str(database / 'memory.sqlite3'),
                   ETAS_HOST_SESSION='sqlite:' + str(database / 'session.sqlite3'))
        session_id, save_id = mode + '-new', 'save1'
        bodies = ['duplicate', '', '雪😀"\\\n\r\t\x00duplicate']
        payload = json.dumps(['nomo-session-bundle-v1', session_id, save_id, *bodies], ensure_ascii=False)
        def invoke(action):
            return command(['run', str(project), '--allow-effects', '--args', action, session_id, save_id, payload], env)
        setup = invoke('setup')
        assert setup.returncode == 0 and 'SETUP_EMPTY' in setup.stdout, setup.stdout + setup.stderr
        saved = invoke('save')
        assert saved.returncode == 0 and not saved.stdout.startswith('REFUSED'), saved.stdout + saved.stderr
        wanted = expected(mode, session_id, bodies)
        assert json.loads(saved.stdout) == wanted, (saved.stdout, wanted)
        loaded = invoke('load')
        assert loaded.returncode == 0 and json.loads(loaded.stdout) == wanted, loaded.stdout + loaded.stderr
        repeated = invoke('save')
        assert 'REFUSED session metadata already exists' in repeated.stdout, repeated.stdout + repeated.stderr
        print('PASS separate_process_' + mode + '_lossless_exact_state_and_no_second_save', flush=True)
    print('PASS initial_storage_roundtrips', flush=True)


def negative_cases(project, source, command):
    source.write_text(fixture_source('stub'))
    bodies = ['hello', '', 'OUTCOME']
    session_id, save_id = 'negative-new', 'save1'
    payload = json.dumps(['nomo-session-bundle-v1', session_id, save_id, *bodies])

    def case(name, actions, expected_refusal):
        database = project / name
        database.mkdir()
        env = dict(os.environ, ETAS_HOST_MEMORY='sqlite:' + str(database / 'memory.sqlite3'),
                   ETAS_HOST_SESSION='sqlite:' + str(database / 'session.sqlite3'))
        corrupted = None
        def contents():
            observed = {}
            for filename in ('memory.sqlite3', 'session.sqlite3'):
                with sqlite3.connect('file:' + str(database / filename) + '?mode=ro', uri=True) as connection:
                    observed[filename] = '\n'.join(connection.iterdump())
            return observed
        for action, extra in actions:
            if action in ('corrupt-memory', 'corrupt-history'):
                # Deliberate test-only corruption in this case's disposable store.
                filename, statement = ('memory.sqlite3', "UPDATE memory_entries SET value_json='{'") if action == 'corrupt-memory' else (
                    'session.sqlite3', "UPDATE session_messages SET payload_json='{'")
                with sqlite3.connect(database / filename) as connection:
                    assert connection.execute(statement).rowcount == 1
                corrupted = contents()
                continue
            result = command(['run', str(project), '--allow-effects', '--args', action, session_id, save_id, payload, *extra], env)
            if action == 'setup':
                assert result.returncode == 0 and 'SETUP_EMPTY' in result.stdout, result.stdout + result.stderr
            elif action.startswith('seed-'):
                assert result.returncode == 0 and 'SEEDED_' in result.stdout, result.stdout + result.stderr
        output = result.stdout + result.stderr
        assert expected_refusal in output, (name, output)
        if corrupted is not None:
            assert result.returncode != 0 and contents() == corrupted, 'corrupt store was accepted or repaired'
        print('PASS ' + name, flush=True)

    case('missing_session_not_empty', [('save', [])], 'missing session fence state')
    case('missing_metadata_not_fresh_reload', [('load', [])], 'session metadata missing')
    case('pending_is_not_runnable', [('setup', []), ('seed-metadata', ['pending']), ('load', [])], 'pending save; recovery required')
    case('pending_cannot_be_resaved', [('setup', []), ('seed-metadata', ['pending']), ('save', [])], 'session metadata already exists')
    case('published_without_history', [('seed-metadata', ['published']), ('load', [])], 'missing session fence state')
    case('unknown_metadata_phase', [('setup', []), ('seed-metadata', ['other']), ('load', [])], 'invalid metadata phase')
    case('preexisting_session_body_refused', [('setup', []), ('seed-raw', [payload]), ('save', [])], 'session history is not empty')
    case('unpublished_orphan_not_visible', [('setup', []), ('seed-raw', [payload]), ('load', [])], 'session metadata missing')
    for label, raw, diagnostic in [
        ('wrong_bundle_marker', ['wrong', session_id, save_id, *bodies], 'unsupported bundle format'),
        ('wrong_bundle_id', ['nomo-session-bundle-v1', 'wrong', save_id, *bodies], 'bundle identity mismatch'),
        ('wrong_save_id', ['nomo-session-bundle-v1', session_id, 'wrong', *bodies], 'bundle identity mismatch'),
        ('missing_bundle_body', ['nomo-session-bundle-v1', session_id, save_id, *bodies[:2]], 'bundle descriptor count mismatch'),
        ('extra_bundle_body', ['nomo-session-bundle-v1', session_id, save_id, *bodies, ''], 'bundle descriptor count mismatch'),
        ('wrong_body_type', ['nomo-session-bundle-v1', session_id, save_id, 12], 'bundle encoded shape or bounds invalid'),
        ('wrong_object_shape', {'format': 1}, 'bundle encoded shape or bounds invalid'),
        ('nested_decoded_shape', ['nomo-session-bundle-v1', session_id, save_id, []], 'bundle encoded shape or bounds invalid'),
        ('body_count_33', ['nomo-session-bundle-v1', session_id, save_id, *([''] * 33)], 'bundle encoded shape or bounds invalid'),
    ]:
        case(label, [('setup', []), ('seed-raw', [json.dumps(raw)]), ('seed-metadata', ['published']), ('load', [])], diagnostic)
    case('extra_session_message', [('setup', []), ('seed-two', [payload]), ('seed-metadata', ['published']), ('load', [])], 'expected exactly one complete bundle')
    case('empty_recorded_history', [('setup', []), ('seed-metadata', ['published']), ('load', [])], 'expected exactly one complete bundle')
    case('corrupt_metadata_refuses_reload', [('setup', []), ('seed-raw', [payload]), ('seed-metadata', ['published']),
         ('corrupt-memory', []), ('load', [])], 'invalid stored JSON')
    case('corrupt_history_refuses_reload', [('setup', []), ('seed-raw', [payload]), ('seed-metadata', ['published']),
         ('corrupt-history', []), ('load', [])], 'invalid stored JSON')
    case('corrupt_history_never_fresh', [('setup', []), ('seed-raw', [payload]), ('corrupt-history', []), ('save', [])],
         'invalid stored JSON')
    print('PASS 22 negative storage cases', flush=True)


if __name__ == '__main__':
    main()
