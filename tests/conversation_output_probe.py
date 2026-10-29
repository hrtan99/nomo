#!/usr/bin/env python3
"""Focused D3 shared stub-controller/output controls; root alone executes.

Collector records the canonical Event through bounded ASCII JSON. Its writes are
Console observation; the semantic controller itself has no native Model, Fs,
Memory, Approval or Command dispatch. This is not a provider/store workflow test.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from harness_checkpoint_contract_probe import source_literal
from edit_write_probe import ascii_json
from model_protocol_probe import resources
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'tests/fixtures/arch_output001'
PRODUCT_HASHES = {
    'src/nomo/model/conversation_output.es': '8be620723d748ed7c1899d3c7915ca277c7c5443b9bf89e6e29f0b465400ca9f',
    'src/nomo/agent/conversation_events.es': '05293169061b3289d5c8c457aca8dbe7a77eeca663b9c4f4a9d1ac4f301edda3',
    'src/nomo/agent/console_events.es': '074d8110db39e73fc510e0fdaa1a368445136bd3731f9d3d9c7fff89fc08f878',
    'src/nomo/agent/stub_loop_controller.es': '4356df446683e4df3a55eab5ec34f760bf188912b8b4e44f6fcc0bfab91a0b6b',
    'src/nomo/agent/loop.es': '4c4079dec612ac3fc768fbaa5f3e75c05ef7ed01381222fe4197a2da8e88a08d',
}
MODULES = ['core/conversation.es', 'core/text.es', 'model/stub.es', 'model/conversation_output.es',
           'agent/conversation_events.es', 'agent/console_events.es', 'agent/stub_loop_controller.es',
           'agent/loop.es', 'tools/edit_encoding.es']
CONTROLLER_FLOWS = ['semantic_emit', 'semantic_controller', 'console_sink', 'collector_observe',
                    'production_observe', 'semantic_observe', 'backend_abort']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def record(name, fields):
    return name + ' { ' + ', '.join(key + ' = ' + value for key, value in fields.items()) + ' }'


def event(role, kind, name='', text=''):
    return dict(role=role, kind=kind, name=name, text=text)


def event_source(value):
    return record('Event', {key: source_literal(value[key]) for key in ['role', 'kind', 'name', 'text']})


def state(events=None, spent=0, stopped=False):
    events = [] if events is None else events
    return dict(events=events, characters=sum(len(row['name']) + len(row['text']) for row in events), spent=spent, stopped=stopped)


def state_source(value):
    return record('State', dict(events='[' + ', '.join(map(event_source, value['events'])) + ']',
                               characters=str(value['characters']), spent=str(value['spent']), stopped=source_literal(value['stopped'])))


def turn_source(value, status):
    return record('Turn', dict(state=state_source(value), status=str(status)))


def cases():
    """Explicit expected event lists; no host-side replica of the stub algorithm."""
    values = []
    def add(label, raw, maximum, budget, previous, appended, spent, status, stopped=None, prior_result=None):
        expected = state(previous['events'] + appended, spent, previous['stopped'] if stopped is None else stopped)
        values.append(dict(label=label, raw=raw, maximum=maximum, budget=budget, previous=previous,
                           appended=appended, expected=expected, status=status, prior_result=prior_result))
        return expected
    initial = state()
    first = add('tool_then_final', 'tool:echo:blue', 3, 6, initial,
                [event('user', 'input', text='tool:echo:blue'), event('model', 'request', 'echo', 'blue'),
                 event('tool', 'complete', 'echo', 'blue'), event('assistant', 'final', text='stub received: blue')], 3, 0)
    add('recall_uses_actual_first_state', ' recall ', 3, 6, first,
        [event('user', 'input', text='recall'), event('assistant', 'final', text='remembered: blue')], 4, 0, prior_result='result_0.state')
    add('invalid_request_rejected', '', 3, 6, initial, [event('error', 'error', text='empty input')], 0, 2)
    already = state([event('assistant', 'final', text='prior')], 5, True)
    add('already_stopped_no_publication', 'ignored', 3, 6, already, [], 5, 4)
    charged = state([event('assistant', 'final', text='prior')], 2)
    add('cumulative_budget_prevents_next_charge', 'hello', 3, 2, charged,
        [event('user', 'input', text='hello'), event('error', 'error', text='invocation step budget exhausted')], 2, 4)
    add('step_limit_prevents_tool_dispatch', 'tool:echo:blue', 1, 6, initial,
        [event('user', 'input', text='tool:echo:blue'), event('model', 'request', 'echo', 'blue'),
         event('error', 'error', text='step limit exhausted')], 1, 4)
    add('unknown_tool_refused', 'tool:other:blue', 3, 6, initial,
        [event('user', 'input', text='tool:other:blue'), event('model', 'request', 'other', 'blue'),
         event('tool', 'error', 'other', 'unknown tool')], 2, 3)
    add('stub_failure_preserved', 'stub:fail', 3, 6, initial,
        [event('user', 'input', text='stub:fail'), event('error', 'error', text='stub failure')], 1, 3)
    slots = state([event('user', 'input') for _ in range(28)], 3)
    add('event_capacity_stops_before_input', 'hello', 3, 6, slots,
        [event('error', 'error', text='history event capacity exhausted; start a new invocation')], 3, 4, stopped=True)
    content = state([event('assistant', 'final', text='p' * 7100)], 3)
    add('content_capacity_stops_before_input', 'hello', 3, 6, content,
        [event('error', 'error', text='history content capacity exhausted; start a new invocation')], 3, 4, stopped=True)
    return values


def statements(values, collector):
    lines = []
    for index, item in enumerate(values):
        lines.append('println(' + source_literal('CASE ' + item['label']) + ');')
        previous = item['prior_result'] or state_source(item['previous'])
        lines.append('let previous_' + str(index) + ' = ' + previous + ';')
        call = 'collected' if collector else 'production_turn'
        arguments = [source_literal(item['raw']), str(item['maximum']), str(item['budget']), 'previous_' + str(index)]
        lines.append('let result_' + str(index) + ' = ' + call + '(' + ', '.join(arguments) + ');')
        lines.append('let expected_' + str(index) + ' = ' + turn_source(item['expected'], item['status']) + ';')
        lines.append('if result_' + str(index) + ' != expected_' + str(index) + ' { abort(' + source_literal('whole Turn differs: ' + item['label']) + '); }')
        lines.append('println(' + source_literal('PASS ' + item['label']) + ');')
    return '\n    '.join(lines)


def formatter_events():
    return [event('model', 'error', 'ignored', 'denied'), event('model', 'text', 'qwen', 'ignored'),
            event('model', 'request', 'read', 'ignored'), event('tool', 'complete', 'read', 'complete: blue\n'),
            event('assistant', 'final', 'ignored', ' A\nB ')]


def formatted(value):
    if value['kind'] == 'error': return 'error: ' + value['text'] + '\n'
    if value['role'] == 'model': return 'model: ' + ('text ' if value['kind'] == 'text' else 'tool ') + value['name'] + '\n'
    if value['role'] == 'tool': return 'tool: ' + value['name'] + ': ' + value['text'] + '\n'
    return value['role'] + ': ' + value['text'] + '\n'


def manifest(module, flows):
    prefix = '[package]\nname = "conversation-output-probe"\nversion = "0.0.0"\nedition = "2026"\n[source]\nroot = "src"\n[runtime]\ndefault_profile = "fixture"\n[runtime.profiles.fixture]\nboundary_policy = "output-no-native-business"\n[runtime.profiles.fixture.policy]\nmode = "local-static"\nrules = ["console=allow", "model=deny", "filesystem=deny", "memory=deny", "session=deny", "approval=deny", "command=deny"]\n[runtime.profiles.fixture.approval]\nmode = "deny"\n'
    return prefix + ''.join('\n[[bin]]\nname = ' + json.dumps(flow) + '\nmodule = ' + json.dumps(module) + '\nflow = ' + json.dumps(flow) + '\nprofile = "fixture"\n' for flow in flows)


def input_hashes(project):
    return {str(path.relative_to(project)): digest(path) for path in sorted((project / 'src').rglob('*.es'))} | {'etas.toml': digest(project / 'etas.toml')}


def copy_modules(project, modules):
    (project / 'src/app').mkdir(parents=True)
    for relative in modules:
        target = project / 'src/nomo' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'src/nomo' / relative, target)


def prepare(folder):
    for relative, expected in PRODUCT_HASHES.items():
        assert digest(ROOT / relative) == expected, relative
    values = cases()
    controller = folder / 'controller'; copy_modules(controller, MODULES)
    semantic_previous = state([event('assistant', 'final', text='prior')], 7, True)
    semantic_event = event('tool', 'complete', 'read', 'é\n')
    semantic_expected = state(semantic_previous['events'] + [semantic_event], 7, True)
    failure_expected = state(semantic_previous['events'] + [event('error', 'error', text='exact failure')], 7, True)
    replacements = dict(__EMPTY__=state_source(state()), __SEMANTIC_PREVIOUS__=state_source(semantic_previous),
                        __SEMANTIC_EXPECTED__=state_source(semantic_expected), __FAILURE_EXPECTED__=turn_source(failure_expected, 37),
                        __COLLECTOR_CASES__=statements(values, True), __PRODUCTION_CASES__=statements(values, False))
    source = (FIXTURES / 'controller_probe.es').read_text()
    for key, value in replacements.items(): source = source.replace(key, value)
    assert not re.search(r'__[A-Z_]+__', source)
    (controller / 'src/app/output_probe.es').write_text(source)
    (controller / 'etas.toml').write_text(manifest('app.output_probe', ['collector_observe', 'production_observe', 'semantic_observe', 'backend_abort']))
    formatter = folder / 'formatter'; copy_modules(formatter, ['core/conversation.es', 'model/conversation_output.es', 'agent/console_events.es'])
    body = '\n    '.join('let event_' + str(i) + ' = ' + event_source(value) + ';\n    publish(event_' + str(i) + ');' for i, value in enumerate(formatter_events()))
    source = (FIXTURES / 'formatter_probe.es').read_text().replace('__EVENTS__', body)
    (formatter / 'src/app/formatter_probe.es').write_text(source)
    (formatter / 'etas.toml').write_text(manifest('app.formatter_probe', ['observe']))
    production = folder / 'production'
    shutil.copytree(ROOT / 'src', production / 'src')
    (production / 'etas.toml').write_text(manifest('nomo.main', ['main']))
    for name in ['wrong_output', 'extra_error']:
        project = folder / name; copy_modules(project, ['core/conversation.es', 'model/conversation_output.es'])
        shutil.copyfile(FIXTURES / (name + '.es'), project / 'src/app/callable_negative.es')
        (project / 'etas.toml').write_text(manifest('app.callable_negative', ['main']))
    return values, {name: input_hashes(folder / name) for name in ['controller', 'formatter', 'production', 'wrong_output', 'extra_error']}


def environment():
    names = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CARGO_HOME', 'CARGO_TARGET_DIR']
    return {name: os.environ[name] for name in names if name in os.environ} | dict(NOMO_NORMAL_GRAPH='latest', ETAS_HOST_FILESYSTEM='none',
        ETAS_HOST_MEMORY='none', ETAS_HOST_SESSION='none', ETAS_HOST_APPROVAL='deny')


def action_rows(item):
    assert item['exit'] == 0 and not item['stderr'], item['label']
    rows = {}
    for name in ['escaping effects', 'requested actions', 'default actions']:
        values = re.findall(r'^\s*' + name + r': (.+)$', item['stdout'], re.M)
        assert len(values) == 1 and values[0].startswith('[') and values[0].endswith(']'), item['label']
        parts = values[0][1:-1].split(', ') if values[0] != '[]' else []
        assert len(parts) == len(set(parts)), item['label']
        rows[name] = set(parts)
    return rows


def trace(path, completed, writes):
    value = json.loads(path.read_text())
    assert value['schema'] == 'etas.cli.interpreter-report.v1' and not value.get('incomplete', False)
    assert value['outcome']['kind'] == ('completed' if completed else 'failed') and value['termination']['local_work_settled'] is True
    starts = [item for item in value['events'] if item['kind'] == 'host_request_started']
    finishes = [item for item in value['events'] if item['kind'] == 'host_request_finished']
    ids = [item['id'] for item in starts]; ends = [item['id'] for item in finishes]
    assert len(ids) == len(set(ids)) and len(ends) == len(set(ends)) and len(ids) == len(ends) and set(ids) == set(ends)
    assert all(item['outcome']['kind'] == 'succeeded' for item in finishes)
    assert all(item['qualified_action'] in ['Policy.evaluate', 'Console.stdout_write'] for item in starts)
    assert sum(item['qualified_action'] == 'Console.stdout_write' for item in starts) == writes
    return dict(settled=True, native_Model_Fs_Memory_Approval_Command=0, paired_requests=len(starts), Console_stdout_write=writes)


def negative(item, project, code, message):
    assert item['exit'] != 0 and not item['stderr'], item['label']
    report = json.loads(item['stdout'])
    diagnostics = [(Path(file['path']).resolve(), value) for file in report['files'] for value in file['diagnostics']]
    assert len(diagnostics) == 1, item['label']
    path, value = diagnostics[0]; source = project / 'src/app/callable_negative.es'
    line = next(i for i, text in enumerate(source.read_text().splitlines(), 1) if text.startswith('flow bad('))
    assert path == source.resolve() and value['severity'] == 'error' and value['code'] == code and value['message'] == message, item['label']
    assert value['primary']['span']['startLine'] == line, item['label']


def expected_output(values, collector):
    output = ''
    for item in values:
        output += 'CASE ' + item['label'] + '\n'
        for value in item['appended']:
            output += 'COLLECT ' + ascii_json([value[key] for key in ['role', 'kind', 'name', 'text']]) + '\n' if collector else formatted(value)
        output += 'PASS ' + item['label'] + '\n'
    return output


def run(folder, values, inputs):
    cli = verify_cli()
    result = dict(status='running', task='D3 semantic conversation output', inputs=inputs, commands=[], traces={},
                  qualification='Same actual stub controller with real Console facade and bounded source Collector. No native business effects; provider/model-tool legacy Console wrappers remain outside D3.')
    output = folder / 'results.json'; save(output, result); error = None
    try:
        def invoke(project, label, args):
            assert input_hashes(project) == inputs[project.name], label
            command = list(map(str, [cli, '--no-config', *args]))
            item = dict(label=label, command=command); result['commands'].append(item); save(output, result)
            observed = subprocess.run(command, capture_output=True, input=b'', env=environment(), timeout=90)
            (folder / (label + '.stdout.bin')).write_bytes(observed.stdout)
            (folder / (label + '.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode()); save(output, result)
            return item
        for name in ['controller', 'formatter', 'production']:
            project = folder / name
            item = invoke(project, name + '-check', ['check', '--all', project])
            assert item['exit'] == 0 and not item['stderr'] and item['stdout'] == 'checked ' + str(len(inputs[name]) - 1) + ' files\n', name + '-check: see preserved raw diagnostics'
        for flow in CONTROLLER_FLOWS[:-1]:
            item = invoke(folder / 'controller', flow + '-effects', ['effects', folder / 'controller', '--flow', flow]); rows = action_rows(item)
            console = {'Console.stdout_write'}; publish = {'ConversationOutput.publish'}
            if flow in ['semantic_emit', 'semantic_controller']:
                assert rows['requested actions'] == publish and rows['default actions'] == set(), flow
                assert 'ConversationOutput.publish' in rows['escaping effects'] and not any('std.io.IOError' in value for value in rows['escaping effects']), flow
            elif flow == 'console_sink':
                assert rows['escaping effects'] == {'Error<std.io.IOError>'} and rows['requested actions'] == rows['default actions'] == console, flow
            else:
                assert rows['requested actions'] == console | publish and rows['default actions'] == console, flow
                assert 'ConversationOutput.publish' not in rows['escaping effects'], flow
        def observed(name, flow, expected, writes):
            project = folder / name; label = name + '-' + flow
            item = invoke(project, label, ['run', project, '--flow', flow, '--allow-effects', '--budget-time', '30s', '--trace-out', folder / (label + '.trace.json')])
            assert item['exit'] == 0 and not item['stderr'] and item['stdout'] == expected, label + ': exact stdout/whole-state oracle failed; see raw artifacts'
            result['traces'][label] = trace(folder / (label + '.trace.json'), True, writes)
        for collector in [True, False]:
            observed('controller', 'collector_observe' if collector else 'production_observe', expected_output(values, collector), 2 * len(values) + sum(len(value['appended']) for value in values))
        semantic_rows = [event('tool', 'complete', 'read', 'é\n'), event('error', 'error', text='exact failure')]
        semantic_labels = ['unicode_append', 'failure_status']
        semantic_output = ''.join('CASE ' + label + '\nCOLLECT ' + ascii_json([value[key] for key in ['role', 'kind', 'name', 'text']]) + '\nPASS ' + label + '\n' for label, value in zip(semantic_labels, semantic_rows))
        observed('controller', 'semantic_observe', semantic_output, 6)
        # Literal byte oracle is independent of the branch helper used above.
        observed('formatter', 'observe', 'error: denied\nmodel: text qwen\nmodel: tool read\ntool: read: complete: blue\n\nassistant:  A\nB \n', 5)
        item = invoke(folder / 'controller', 'backend-abort-run', ['run', folder / 'controller', '--flow', 'backend_abort', '--allow-effects', '--budget-time', '10s', '--trace-out', folder / 'backend-abort.trace.json'])
        assert item['exit'] != 0 and item['stdout'].startswith('PORT backend_abort publish\n') and 'D3_EXPECTED_OUTPUT_ABORT' in item['stdout'] + item['stderr'], 'backend-abort-run'
        assert 'UNREACHABLE' not in item['stdout'] + item['stderr'], 'backend-abort-run returned a State'
        result['traces']['backend_abort'] = trace(folder / 'backend-abort.trace.json', False, 1)
        for name, code, message in [('wrong_output', 'type::TypeMismatch', 'implementation output type does not satisfy the callable spec'),
                                    ('extra_error', 'effect::EffectOutsideDeclaredRow', 'implementation escaping effects do not satisfy the callable spec bound')]:
            project = folder / name
            item = invoke(project, name + '-check', ['--format', 'json', 'check', '--all', project]); negative(item, project, code, message)
        for name, expected in inputs.items(): assert input_hashes(folder / name) == expected, name
        result.update(status='passed', controller_cases_per_backend=len(values), semantic_cases=2, formatter_cases=5,
                      source_output_abort_cases=1, callable_negative_cases=2, native_Model_Fs_Memory_Approval_Command=0)
    except BaseException as failure:
        error = failure; result.update(status='failed', failure_class=type(failure).__name__, failure=str(failure))
    finally:
        try:
            result['resources'], valid = resources()
            if not valid: result.update(status='failed', resource_failure=True)
        except BaseException as failure:
            valid = False; result.update(status='failed', resources=None, resource_failure=type(failure).__name__); error = error or failure
        save(output, result)
    if error is not None: raise error
    assert valid, str(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args(); args.evidence_dir.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='conversation-output-', dir=args.evidence_dir))
    print('EVIDENCE ' + str(folder), flush=True)
    values, inputs = prepare(folder)
    save(folder / 'preparation.json', dict(status='prepared', driver_sha256=digest(Path(__file__)), inputs=inputs,
         controller_cases=[dict(label=value['label'], published_events=len(value['appended'])) for value in values],
         qualification='Preparation only. No compiler, test, Host, provider or store operation occurred during source authoring.'))
    if not args.prepare_only: run(folder, values, inputs)


if __name__ == '__main__':
    main()
