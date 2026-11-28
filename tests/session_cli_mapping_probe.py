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

SOURCE = 'module app.main;\nimport std.io.println;\nimport std.io.read_all;\nimport std.text.char_count as len;\nimport std.text.from_i32;\nimport std.collections.len as count;\nimport std.json.parse;\nimport std.agent.message.Message;\nimport nomo.domain.conversation.State;\nimport nomo.domain.conversation.Event;\nimport nomo.domain.conversation.fresh;\nimport nomo.agent.loop.turn;\nimport nomo.session.stub_snapshot.snapshot;\nimport nomo.session.stub_snapshot.caps;\nimport nomo.domain.sessions.state.Projection;\nimport nomo.domain.sessions.state.Request;\nimport nomo.domain.sessions.state.Snapshot;\nimport nomo.domain.sessions.state.validate;\nimport nomo.session.session_display.display;\n\nflow project(state: State, maximum: i32, budget: i32, expected_lifecycle: string) -> Projection {\n    let saved = match snapshot(state, "fixture-session", "independent-binding", maximum, budget) {\n        Ok(value) => value, Err(_) => { abort("mapping refused valid fixture"); }\n    };\n    if saved.history != state || saved.generation != 0 || saved.mode != "stub" ||\n        saved.original_caps != caps(maximum, budget) || saved.current_caps != caps(maximum, budget) {\n        abort("mapping changed actual state or caps");\n    }\n    if saved.lifecycle != expected_lifecycle {\n        abort("mapping lifecycle disagrees with fixture");\n    }\n    let request = Request { session_id = "fixture-session", mode = "stub", binding = "independent-binding", caps = caps(maximum, budget) };\n    return match validate(saved, request) { Ok(value) => value, Err(_) => { abort("mapped validation refused"); } };\n}\n\npublic flow mapping_pure() -> bool {\n    return match snapshot(fresh(), "id", "binding", 3, 16) { Ok(_) => true, Err(_) => false };\n}\npublic flow display_pure() -> bool {\n    return match display(project(fresh(), 3, 16, "active")) { Ok(_) => true, Err(_) => false };\n}\nflow observed(label: string, raw: string, maximum: i32, budget: i32, expected_lifecycle: string) -> unit {\n    let original = turn(raw, maximum, budget, fresh());\n    let projection = project(original.state, maximum, budget, expected_lifecycle);\n    let before = projection;\n    let output = match display(projection) { Ok(value) => value, Err(_) => { abort("display refused valid projection"); } };\n    if projection != before { abort("display mutated projection"); }\n    println("MAPPED " + label + " " + from_i32(original.status) + " " + output);\n}\nflow refuses(state: State, maximum: i32, budget: i32) -> bool {\n    return match snapshot(state, "id", "binding", maximum, budget) { Err(_) => true, Ok(_) => false };\n}\nflow with_disposition(value: Projection, disposition: string) -> Projection {\n    return Projection { session_id = value.session_id, generation = value.generation, mode = value.mode,\n        binding = value.binding, disposition = disposition, history = value.history, references = value.references,\n        operations = value.operations, original_caps = value.original_caps, caps = value.caps, ledger = value.ledger };\n}\npublic flow main(args: Array<string>) -> i32 {\n    let empty = fresh();\n    if !refuses(empty, 0, 16) || !refuses(empty, 3, 17) { abort("invalid caps accepted"); }\n    let orphan = State { events = [Event { role = "tool", kind = "complete", name = "echo", text = "x" }], characters = 5, spent = 1, stopped = false };\n    if !refuses(orphan, 3, 16) { abort("orphan tool accepted"); }\n    let mismatch = State { events = [Event { role = "model", kind = "request", name = "echo", text = "x" },\n        Event { role = "tool", kind = "complete", name = "other", text = "x" }], characters = 11, spent = 2, stopped = false };\n    if !refuses(mismatch, 3, 16) { abort("mismatched tool accepted"); }\n    println("PASS direct mapping refusals");\n    let stopped_request = State { events = [Event { role = "model", kind = "request", name = "echo", text = "x" }],\n        characters = 5, spent = 1, stopped = true };\n    let stopped_pending = project(stopped_request, 3, 16, "recovery-required");\n    if stopped_pending.disposition != "recovery-required" { abort("pending lifecycle lost precedence over stopped"); }\n    println("PASS pending lifecycle precedence");\n    let first = match snapshot(fresh(), "fixture-session", "independent-binding", 3, 16) { Ok(value) => value, Err(_) => { abort("empty mapping refused"); } };\n    let recovering = Snapshot { format = first.format, session_id = first.session_id, generation = first.generation,\n        mode = first.mode, binding = first.binding, lifecycle = "recovery-required", history = first.history,\n        references = first.references, operations = first.operations, original_caps = first.original_caps,\n        current_caps = first.current_caps, ledger = first.ledger };\n    let request = Request { session_id = first.session_id, mode = first.mode, binding = first.binding, caps = first.current_caps };\n    let recovered = match validate(recovering, request) { Ok(value) => value, Err(_) => { abort("recovery projection refused"); } };\n    match display(recovered) { Ok(value) => { println("RECOVERY " + value); }, Err(_) => { abort("explicit recovery display refused"); } }\n    match display(with_disposition(recovered, "invalid")) { Err(_) => { println("PASS invalid display disposition"); }, Ok(_) => { abort("invalid disposition accepted"); } }\n    __TURN_CASES__\n    let parsed = match parse(read_all()) { Ok(value) => value, Err(_) => { abort("invalid display fixture JSON"); } };\n    let message = Message.new(parsed);\n    let conversion: Option<Message<Array<string>>> = message.cast<Array<string>>();\n    let bodies = match conversion { Some(value) => value.body, None() => { abort("invalid display fixture shape"); } };\n    for body in bodies limit Iterations(16) {\n        let state = State { events = [Event { role = "user", kind = "input", name = "", text = body }],\n            characters = len(body), spent = 0, stopped = true };\n        let projection = project(state, 3, 16, "stopped");\n        let output = match display(projection) { Ok(value) => value, Err(_) => { abort("Unicode display refused"); } };\n        if projection.history.events[0].text != body { abort("Unicode display changed stored body"); }\n        println("DISPLAY " + output);\n    }\n    return 0;\n}\n'


def main():
    assert digest(CLI) == json.loads((GRAPH / 'binary.json').read_text())['sha256']
    protected = {name: digest(ROOT / name) for name in ['etas.toml', 'etas.lock', 'src/nomo/agent/loop.es', 'src/nomo/domain/sessions/state.es']}
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
