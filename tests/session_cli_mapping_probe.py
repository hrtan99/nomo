#!/usr/bin/env python3
"""SESSION-CLI pure mapping/display and actual unchanged stub-loop observations."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from session_store_probe import CLI, EVIDENCE, GRAPH, ROOT, digest, retain_input

CASES = [
    ('plain', 'hello', 3, 16, 1, 0, False, None, 'active'),
    ('echo', 'tool:echo:abc', 3, 16, 3, 0, False, 'completed', 'active'),
    ('tool-error', 'tool:echo:fail', 3, 16, 2, 3, False, 'completed', 'active'),
    ('unknown-tool', 'tool:other:abc', 3, 16, 2, 3, False, 'completed', 'active'),
    ('stub-error', 'stub:fail', 3, 16, 1, 3, False, None, 'active'),
    ('recall-error', 'recall', 3, 16, 1, 3, False, None, 'active'),
    ('malformed-tool', 'tool:echo', 3, 16, 1, 3, False, None, 'active'),
    ('pending-turn-limit', 'tool:echo:abc', 1, 16, 1, 4, True, 'pending', 'recovery-required'),
    ('pending-budget', 'tool:echo:abc', 3, 1, 1, 4, True, 'pending', 'recovery-required'),
    ('completed-turn-limit', 'tool:echo:abc', 2, 16, 2, 4, False, 'completed', 'active'),
    ('completed-budget', 'tool:echo:abc', 3, 2, 2, 4, True, 'completed', 'active'),
    ('empty-input', '', 3, 16, 0, 2, False, None, 'active'),
    ('oversize-input', 'x' * 1025, 3, 16, 0, 2, False, None, 'active'),
]

SOURCE = '''module app.main;
import std.io.{println, read_all};
import std.text.{len, to_string_i32};
import std.collections.len as count;
import std.json.parse;
import std.agent.message.Message;
import nomo.core.conversation.{State, Event, fresh};
import nomo.agent.loop.turn;
import nomo.session.stub_snapshot.{snapshot, caps};
import nomo.session.session_state.{Projection, Request, Snapshot, validate};
import nomo.session.session_display.display;

flow project(state: State, maximum: i32, budget: i32, expected_lifecycle: string) -> Projection {
    let saved = match snapshot(state, "fixture-session", "independent-binding", maximum, budget) {
        Ok(value) => value, Err(_) => { abort("mapping refused valid fixture"); }
    };
    if saved.history != state || saved.generation != 0 || saved.mode != "stub" ||
        saved.original_caps != caps(maximum, budget) || saved.current_caps != caps(maximum, budget) {
        abort("mapping changed actual state or caps");
    }
    if saved.lifecycle != expected_lifecycle {
        abort("mapping lifecycle disagrees with fixture");
    }
    let request = Request { session_id = "fixture-session", mode = "stub", binding = "independent-binding", caps = caps(maximum, budget) };
    return match validate(saved, request) { Ok(value) => value, Err(_) => { abort("mapped validation refused"); } };
}

public flow mapping_pure() -> bool {
    return match snapshot(fresh(), "id", "binding", 3, 16) { Ok(_) => true, Err(_) => false };
}
public flow display_pure() -> bool {
    return match display(project(fresh(), 3, 16, "active")) { Ok(_) => true, Err(_) => false };
}
flow observed(label: string, raw: string, maximum: i32, budget: i32, expected_lifecycle: string) -> unit {
    let original = turn(raw, maximum, budget, fresh());
    let projection = project(original.state, maximum, budget, expected_lifecycle);
    let before = projection;
    let output = match display(projection) { Ok(value) => value, Err(_) => { abort("display refused valid projection"); } };
    if projection != before { abort("display mutated projection"); }
    println("MAPPED " + label + " " + to_string_i32(original.status) + " " + output);
}
flow refuses(state: State, maximum: i32, budget: i32) -> bool {
    return match snapshot(state, "id", "binding", maximum, budget) { Err(_) => true, Ok(_) => false };
}
flow with_disposition(value: Projection, disposition: string) -> Projection {
    return Projection { session_id = value.session_id, generation = value.generation, mode = value.mode,
        binding = value.binding, disposition = disposition, history = value.history, references = value.references,
        operations = value.operations, original_caps = value.original_caps, caps = value.caps, ledger = value.ledger };
}
public flow main(args: Array<string>) -> i32 {
    let empty = fresh();
    if !refuses(empty, 0, 16) || !refuses(empty, 3, 17) { abort("invalid caps accepted"); }
    let orphan = State { events = [Event { role = "tool", kind = "complete", name = "echo", text = "x" }], characters = 5, spent = 1, stopped = false };
    if !refuses(orphan, 3, 16) { abort("orphan tool accepted"); }
    let mismatch = State { events = [Event { role = "model", kind = "request", name = "echo", text = "x" },
        Event { role = "tool", kind = "complete", name = "other", text = "x" }], characters = 11, spent = 2, stopped = false };
    if !refuses(mismatch, 3, 16) { abort("mismatched tool accepted"); }
    println("PASS direct mapping refusals");
    let stopped_request = State { events = [Event { role = "model", kind = "request", name = "echo", text = "x" }],
        characters = 5, spent = 1, stopped = true };
    let stopped_pending = project(stopped_request, 3, 16, "recovery-required");
    if stopped_pending.disposition != "recovery-required" { abort("pending lifecycle lost precedence over stopped"); }
    println("PASS pending lifecycle precedence");
    let first = match snapshot(fresh(), "fixture-session", "independent-binding", 3, 16) { Ok(value) => value, Err(_) => { abort("empty mapping refused"); } };
    let recovering = Snapshot { format = first.format, session_id = first.session_id, generation = first.generation,
        mode = first.mode, binding = first.binding, lifecycle = "recovery-required", history = first.history,
        references = first.references, operations = first.operations, original_caps = first.original_caps,
        current_caps = first.current_caps, ledger = first.ledger };
    let request = Request { session_id = first.session_id, mode = first.mode, binding = first.binding, caps = first.current_caps };
    let recovered = match validate(recovering, request) { Ok(value) => value, Err(_) => { abort("recovery projection refused"); } };
    match display(recovered) { Ok(value) => { println("RECOVERY " + value); }, Err(_) => { abort("explicit recovery display refused"); } }
    match display(with_disposition(recovered, "invalid")) { Err(_) => { println("PASS invalid display disposition"); }, Ok(_) => { abort("invalid disposition accepted"); } }
    __TURN_CASES__
    let parsed = match parse(read_all()) { Ok(value) => value, Err(_) => { abort("invalid display fixture JSON"); } };
    let message = Message.new(parsed);
    let conversion: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let bodies = match conversion { Some(value) => value.body, None() => { abort("invalid display fixture shape"); } };
    for body in bodies limit Iterations(16) {
        let state = State { events = [Event { role = "user", kind = "input", name = "", text = body }],
            characters = len(body), spent = 0, stopped = true };
        let projection = project(state, 3, 16, "stopped");
        let output = match display(projection) { Ok(value) => value, Err(_) => { abort("Unicode display refused"); } };
        if projection.history.events[0].text != body { abort("Unicode display changed stored body"); }
        println("DISPLAY " + output);
    }
    return 0;
}
'''


def main():
    assert digest(CLI) == json.loads((GRAPH / 'binary.json').read_text())['sha256']
    protected = {name: digest(ROOT / name) for name in ['etas.toml', 'etas.lock', 'src/nomo/agent/loop.es', 'src/nomo/session/session_state.es']}
    project = Path(tempfile.mkdtemp(prefix='session-cli-mapping-', dir=EVIDENCE))
    print('EVIDENCE ' + str(project), flush=True)
    target = project / 'src/nomo'
    target.mkdir(parents=True)
    for name in ['core/conversation.es', 'agent/loop.es', 'model/stub.es', 'core/text.es', 'session/session_state.es']:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'src/nomo' / name, destination)
    for name in ['session/stub_snapshot.es', 'session/session_display.es']:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'src/nomo' / name, destination)
    source = project / 'src/app/main.es'
    source.parent.mkdir()
    calls = '\n'.join('observed(' + ', '.join(json.dumps(v) for v in (*case[:4], case[-1])) + ');' for case in CASES)
    source.write_text(SOURCE.replace('__TURN_CASES__', calls))
    (project / 'etas.toml').write_text('''[package]
name = "session-cli-mapping-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "session-cli-mapping-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.main"
flow = "main"
profile = "fixture"
''')
    (project / 'product-sources.json').write_text(json.dumps({str(p.relative_to(project)): digest(p) for p in target.rglob('*.es')}, indent=2))
    results = []

    def invoke(arguments, stdin=None):
        inputs = retain_input(project, source)
        if stdin is not None:
            (project / 'stdin.json').write_text(stdin)
            inputs['stdin.json'] = {'retained': 'stdin.json', 'sha256': digest(project / 'stdin.json')}
        run = subprocess.run([str(CLI), *arguments], input=stdin, text=True, capture_output=True, timeout=240)
        results.append({'command': [str(CLI), *arguments], 'exit': run.returncode,
                        'stdout': run.stdout, 'stderr': run.stderr, 'inputs': inputs})
        (project / 'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
        assert run.returncode == 0, run.stdout + run.stderr
        return run

    invoke(['check', '--all', str(project)])
    for flow in ['mapping_pure', 'display_pure']:
        effects = invoke(['effects', str(project), '--flow', flow])
        assert 'requested actions: []' in effects.stdout, effects.stdout
        print('PASS no Host actions: ' + flow, flush=True)
    bodies = ['', ''.join(chr(n) for n in range(160)), '"\\\n\r\t\x1b[31m',
              'é世界😀\u2028\u2029\u202e\u2066', '\u0080\u07ff\u0800\uffff\U00010000\U0010ffff',
              r'literal \u0000 \u202e \n', '😀' * 8192]
    run = invoke(['run', str(project), '--allow-effects'], json.dumps(bodies, ensure_ascii=False))
    assert 'PASS direct mapping refusals\n' in run.stdout, run.stdout
    assert 'PASS pending lifecycle precedence\n' in run.stdout, run.stdout
    assert 'PASS invalid display disposition\n' in run.stdout, run.stdout
    recovery = [json.loads(line[9:]) for line in run.stdout.split('\n') if line.startswith('RECOVERY ')]
    assert len(recovery) == 1 and recovery[0]['disposition'] == 'recovery-required' and recovery[0]['operations'] == [] and recovery[0]['history']['stopped'] is True, recovery
    mapped = [line.split(' ', 3) for line in run.stdout.split('\n') if line.startswith('MAPPED ')]
    assert len(mapped) == len(CASES), run.stdout
    for case, (_, label, status, output) in zip(CASES, mapped):
        name, _, maximum, budget, spent, expected_status, stopped, operation_status, expected_lifecycle = case
        assert label == name and int(status) == expected_status
        assert output.isascii() and all(32 <= ord(char) < 127 for char in output) and len(output) <= 131072, label
        value = json.loads(output)
        assert value['history']['spent'] == spent and value['history']['stopped'] is stopped, (label, value)
        assert value['generation'] == 0 and value['mode'] == 'stub', (label, value)
        assert value['caps'] == value['original_caps'] == {'steps': budget, 'turn_steps': maximum, 'attempts': 0, 'tokens': 0, 'scan_bytes': 0}, value
        assert value['disposition'] == ('recovery-required' if operation_status == 'pending' else 'validated'), value
        if operation_status:
            assert value['operations'] == [{'id': 'stub-request-1', 'status': operation_status, 'attempts': 0, 'tokens': 0, 'scan_bytes': 0}], value
            assert value['references'][1] == {'operation': 'stub-request-1', 'phase': 'request'}, value
            assert value['references'][2] == ({'operation': 'stub-request-1', 'phase': 'outcome'} if operation_status == 'completed' else {'operation': '', 'phase': ''}), value
        else:
            assert value['operations'] == [] and all(ref == {'operation': '', 'phase': ''} for ref in value['references']), value
        print('PASS actual stub mapping: ' + label, flush=True)
    displayed = [line[8:] for line in run.stdout.split('\n') if line.startswith('DISPLAY ')]
    assert len(displayed) == len(bodies), len(displayed)
    for index, (body, output) in enumerate(zip(bodies, displayed)):
        assert output.isascii() and all(32 <= ord(char) < 127 for char in output) and len(output) <= 131072, index
        assert json.loads(output)['history']['events'][0]['text'] == body, index
        print('PASS exact escaped Unicode/control display: ' + str(index), flush=True)
    assert all(digest(ROOT / name) == before for name, before in protected.items())
    print('PASS 13 actual stub mappings, 4 direct refusals, 1 pending lifecycle precedence, 7 lossless ASCII display cases, 2 disposition cases, 2 pure-effect checks', flush=True)


if __name__ == '__main__':
    main()
