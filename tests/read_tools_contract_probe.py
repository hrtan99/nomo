#!/usr/bin/env python3
"""Focused ARCH-READ-001 source/effects/deterministic controls; root executes only.

PORT counts are source Model/ReadTools handler interpretation counts, never native
Model/Fs counts. Both stateless implementations use the same controller. Production
read/search/facade are checked and queried only; negative callables are never run.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from harness_checkpoint_contract_probe import source_literal
from model_protocol_probe import resources
from normal_graph_identity import verify_cli
from trace_report_contract import validate_report

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'tests/fixtures/arch_read001'
# The workspace hash includes 492fe81's bounded native read. This suite checks
# its source/effects only; its interpreted fixture does not execute native Fs.
PRODUCT_HASHES = {'src/nomo/agent/model_tool.es': 'f95117bd9c16dc54d28090664f8aad33f4f9e306e6f65db88982d9e166a64fc6', 'src/nomo/agent/model_tool_controller.es': '2f23f5a6d7d5427ad92bb51771163010aa3c8d2d87cdefc6792e018b2ec768cd', 'src/nomo/tools/workspace.es': '664b846f941e62f70f7a875e84e5b352c6d980a395a671c69d4f9081983b5d8c', 'src/nomo/tools/read_contract.es': '2eccc270199e38581bf4fcc2f8fc327f1dcbd4f3c62ddceeec01a9105c6afabc'}
POSITIVE_MODULES = ['agent/loop.es', 'agent/model_tool_controller.es', 'context/preflight.es', 'context/selection.es', 'core/conversation.es', 'core/text.es', 'harness/harness_edit_contract.es', 'harness/harness_model_contract.es', 'harness/harness_tool_contract.es', 'harness/harness_work_contract.es', 'harness/legacy_string_stages.es', 'harness/model_plan_diagnostic.es', 'model/model_tool_contract.es', 'model/stub.es', 'model/tool_context.es', 'session/edit_operation.es', 'tools/edit_encoding.es', 'tools/edit_proposal.es', 'tools/path_policy.es', 'tools/read_contract.es']
# Current main's loop facade imports the following source implementations.
POSITIVE_MODULES += ['agent/console_events.es', 'agent/conversation_events.es', 'agent/stub_loop_controller.es', 'model/conversation_output.es']
NEGATIVE_MODULES = ['core/text.es', 'tools/read_contract.es']

def record(name, fields):
    return name + ' { ' + ', '.join(key + ' = ' + (value if isinstance(value, Source) else source_literal(value)) for key, value in fields.items()) + ' }'


class Source(str):
    pass


def event(role, kind, name, text):
    return dict(role=role, kind=kind, name=name, text=text)


def session(events, spent=0, calls=0, tokens=0, tools=0, scan=0):
    state = record('State', dict(events=Source('[' + ', '.join(record('Event', value) for value in events) + ']'),
                                characters=sum(len(value['name']) + len(value['text']) for value in events), spent=spent, stopped=False))
    return record('Session', dict(history=Source(state), calls=calls, tokens=tokens, tools=tools, scan=scan))


def context(events, allowed, final_only):
    return record('Context', dict(history=Source('[' + ', '.join(record('Event', value) for value in events) + ']'),
                                 allowed=allowed, final_only=final_only))


def cases():
    values = []
    for mode in ['read_complete', 'search_complete', 'read_refused', 'display_cap_refused',
                 'model_budget_refused', 'tool_budget_refused', 'final_budget_refused', 'context_refused']:
        allowed = ['a.txt', 'b.txt'] if mode == 'search_complete' else ['refused.txt'] if mode == 'read_refused' else ['large.txt'] if mode == 'display_cap_refused' else ['a.txt']
        operation = 'search' if mode == 'search_complete' else 'read'
        command = json.dumps(['search', 'blue', *allowed] if operation == 'search' else ['read', allowed[0]], separators=(',', ':'))
        seed = [event('user', 'context', 'parent', '雪' * 700)] if mode == 'context_refused' else []
        events = seed + [event('user', 'input', '', 'Task')]
        initial = context(events, allowed, False)
        limits = dict(steps=3, calls=0 if mode == 'model_budget_refused' else 1 if mode == 'final_budget_refused' else 2,
                      tokens=4096, scan=4095 if mode == 'tool_budget_refused' else 4096)
        spent = calls = tokens = tools = scan = 0
        models = reads = searches = 0
        status = 4
        if mode in ['context_refused', 'model_budget_refused']:
            error = 'required model context exceeds 2048 encoded UTF-8 bytes' if mode == 'context_refused' else 'model call reservation exhausted'
            events += [event('error', 'error', '', error)]
        else:
            models = 1; spent = 1; calls = 1; tokens = 2048
            events += [event('model', 'text', 'qwen', ''), event('model', 'request', operation, command)]
            if mode == 'tool_budget_refused':
                events += [event('error', 'error', '', 'tool scan reservation exhausted')]
            else:
                spent = 2; tools = 1; scan = 4096
                reads = 1 if operation == 'read' else 0; searches = 1 if operation == 'search' else 0
                if mode in ['read_refused', 'display_cap_refused']:
                    data = 'refused: fixture refusal' if mode == 'read_refused' else 'refused: tool result exceeds 256 display characters'
                    events += [event('tool', 'error', operation, data)]; status = 3
                else:
                    data = 'complete: a.txt:1<LF>b.txt:1<LF>' if operation == 'search' else 'complete: blue<LF>'
                    events += [event('tool', 'complete', operation, data)]
                    if mode == 'final_budget_refused':
                        events += [event('error', 'error', '', 'model call reservation exhausted')]
                    else:
                        models = 2; spent = 3; calls = 2; tokens = 4096; status = 0
                        events += [event('model', 'text', 'qwen', ''), event('assistant', 'final', '', 'Seen blue')]
        second_events = events[:-2] if status == 0 else []
        expected = record('LoopTurn', dict(state=Source(session(events, spent, calls, tokens, tools, scan)), status=status))
        for alternate in ([False, True] if mode in ['read_complete', 'search_complete'] else [False]):
            label = mode + ('_B' if alternate else '_A')
            arguments = [source_literal(label), source_literal(alternate), source_literal(allowed), source_literal(command),
                         session(seed), record('Limits', limits), initial, context(second_events, allowed, True), expected,
                         str(models), str(reads), str(searches)]
            expression = 'exercise(' + ', '.join(arguments) + ')'
            values.append(dict(label=label, expression=expression, source_counts=dict(Model=models, Read=reads, Search=searches)))
    return values


def manifest(module, flows):
    prefix = '[package]\nname = "arch-read-contract-probe"\nversion = "0.0.0"\nedition = "2026"\n[source]\nroot = "src"\n[runtime]\ndefault_profile = "fixture"\n[runtime.profiles.fixture]\nboundary_policy = "arch-read-no-native-business"\n[runtime.profiles.fixture.policy]\nmode = "local-static"\nrules = ["console=allow", "model=deny", "filesystem=deny", "memory=deny", "session=deny", "approval=deny", "command=deny"]\n[runtime.profiles.fixture.approval]\nmode = "deny"\n'
    return prefix + ''.join('\n[[bin]]\nname = ' + json.dumps(flow) + '\nmodule = ' + json.dumps(module) + '\nflow = ' + json.dumps(flow) + '\nprofile = "fixture"\n' for flow in flows)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def input_hashes(project):
    return {str(path.relative_to(project)): digest(path) for path in sorted((project / 'src').rglob('*.es'))} | {'etas.toml': digest(project / 'etas.toml')}


def environment():
    names = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CARGO_HOME', 'CARGO_TARGET_DIR']
    return {name: os.environ[name] for name in names if name in os.environ} | dict(NOMO_NORMAL_GRAPH='latest',
        ETAS_HOST_FILESYSTEM='none', ETAS_HOST_MEMORY='none', ETAS_HOST_SESSION='none', ETAS_HOST_APPROVAL='deny')


def command(folder, label, argv):
    argv = list(map(str, argv)); save(folder / (label + '.command.json'), argv)
    process = subprocess.run(argv, capture_output=True, input=b'', env=environment(), timeout=180)
    (folder / (label + '.stdout.bin')).write_bytes(process.stdout)
    (folder / (label + '.stderr.bin')).write_bytes(process.stderr)
    return dict(command=argv, stage=label, stdout_artifact=str(folder / (label + '.stdout.bin')),
                stderr_artifact=str(folder / (label + '.stderr.bin')), exit=process.returncode,
                stdout=process.stdout.decode(), stderr=process.stderr.decode())


def diagnostic(item):
    return dict(stage=item['stage'], exit=item['exit'],
                stdout_artifact=item['stdout_artifact'], stderr_artifact=item['stderr_artifact'])


def action_rows(item):
    assert item['exit'] == 0 and not item['stderr'], diagnostic(item)
    assert 'rejected' not in item['stdout'].lower() and 'Unresolved' not in item['stdout'], diagnostic(item)
    result = {}
    for name in ['requested actions', 'default actions']:
        raw = re.findall(r'^\s*' + name + r': (.+)$', item['stdout'], re.M)
        assert len(raw) == 1, diagnostic(item)
        actions = re.findall(r'[A-Za-z_][A-Za-z0-9_.]*(?:\[[^\[\]]+\])?', raw[0][1:-1])
        assert raw[0] == '[' + ', '.join(actions) + ']' and len(actions) == len(set(actions)), diagnostic(item)
        result[name] = set(actions)
    support = re.findall(r'^\s*support: (.+)$', item['stdout'], re.M)
    allowed_support = {'local', 'requires-host[FileIO]',
                       'requires-orchestration[host=FileIO; features=EffectHandler]',
                       'requires-orchestration[host=Console; features=EffectHandler]',
                       'requires-orchestration[host=Agentic, Console, FileIO; features=EffectHandler]'}
    assert len(support) == 1 and support[0] in allowed_support, diagnostic(item)
    result['support'] = support[0]
    return result


def trace(path, completed):
    value = validate_report(json.loads(path.read_text()), completed)
    starts = [item for item in value['events'] if item['kind'] == 'host_request_started']
    finishes = [item for item in value['events'] if item['kind'] == 'host_request_finished']
    ids = [item['id'] for item in starts]; ends = [item['id'] for item in finishes]
    assert len(ids) == len(set(ids)) and len(ends) == len(set(ends)) and len(ids) == len(ends) and set(ids) == set(ends)
    assert all(item['outcome']['kind'] == 'succeeded' for item in finishes)
    assert all(item['qualified_action'] in ['Policy.evaluate', 'Console.stdout_write'] for item in starts)
    return dict(settled=True, native_Model_Fs_Memory_Approval_Command=0, paired_requests=len(starts))


def prepare(folder):
    for relative, expected in PRODUCT_HASHES.items(): assert digest(ROOT / relative) == expected, relative
    values = cases(); source = (FIXTURES / 'controller_probe.es').read_text()
    source = source.replace('__LARGE__', source_literal('A' * 257)).replace('__RAW1024__', source_literal('X' * 1024)).replace('__ESCAPED_OVERFLOW__', source_literal('<' * 257))
    source = source.replace('__CASES__', '\n    '.join('if !' + value['expression'] + ' { abort(' + source_literal('whole LoopTurn differs: ' + value['label']) + '); }\n    println(' + source_literal('PASS ' + value['label']) + ');' for value in values))
    assert not re.search(r'__[A-Z_]+__', source)
    positive = folder / 'deterministic'; (positive / 'src/app').mkdir(parents=True)
    for relative in POSITIVE_MODULES:
        target = positive / 'src/nomo' / relative; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'src/nomo' / relative, target)
    (positive / 'src/app/read_tools_probe.es').write_text(source)
    (positive / 'etas.toml').write_text(manifest('app.read_tools_probe', ['observe', 'backend_abort']))
    production = folder / 'production'; shutil.copytree(ROOT / 'src', production / 'src')
    (production / 'src/app').mkdir(exist_ok=True)
    shutil.copyfile(FIXTURES / 'production_probe.es', production / 'src/app/production_probe.es')
    (production / 'etas.toml').write_text(manifest('app.production_probe', ['production_read', 'production_search', 'production_loop']))
    for name in ['wrong_output', 'extra_error']:
        project = folder / name; (project / 'src/app').mkdir(parents=True)
        for relative in NEGATIVE_MODULES:
            target = project / 'src/nomo' / relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / 'src/nomo' / relative, target)
        shutil.copyfile(FIXTURES / (name + '.es'), project / 'src/app/callable_negative.es')
        (project / 'etas.toml').write_text(manifest('app.callable_negative', ['main']))
    return values, {name: input_hashes(folder / name) for name in ['deterministic', 'production', 'wrong_output', 'extra_error']}


def negative(item, project, expected_code, expected_message):
    assert item['exit'] != 0 and not item['stderr'], diagnostic(item)
    report = json.loads(item['stdout']); assert report['command'] == 'check', diagnostic(item)
    diagnostics = [(Path(file['path']).resolve(), value) for file in report['files'] for value in file['diagnostics']]
    assert len(diagnostics) == 1, diagnostic(item)
    path, value = diagnostics[0]
    source = project / 'src/app/callable_negative.es'
    expected_line = next(index for index, line in enumerate(source.read_text().splitlines(), 1) if line.startswith('flow bad('))
    assert path == source.resolve() and value['severity'] == 'error', diagnostic(item)
    assert value['code'] == expected_code and value['message'] == expected_message, diagnostic(item)
    assert value['primary']['span']['startLine'] == expected_line, diagnostic(item)


def run(folder, values, inputs):
    cli = verify_cli(); result = dict(status='running', inputs=inputs, source_interpretation_counts=None,
        native_business_counts=None, commands=[], qualification='New D2 focused tests only; no old matrix or native business operation. PORT counts denote source handler interpretations.')
    output = folder / 'results.json'; save(output, result); error = None
    try:
        def invoke(project, label, args):
            assert input_hashes(project) == inputs[project.name]
            item = command(folder, label, [cli, '--no-config', *args]); result['commands'].append(item); save(output, result)
            return item
        positive = folder / 'deterministic'; production = folder / 'production'
        for project in [positive, production]:
            item = invoke(project, project.name + '-check', ['check', '--all', project])
            assert item['exit'] == 0 and not item['stderr'] and item['stdout'] == 'checked ' + str(len(list((project / 'src').rglob('*.es')))) + ' files\n', diagnostic(item)
        for flow in ['pure_contract', 'fixture_read_a', 'fixture_read_b', 'fixture_search_a', 'fixture_search_b', 'observe', 'backend_abort']:
            item = invoke(positive, flow + '-effects', ['effects', positive, '--flow', flow]); rows = action_rows(item)
            if flow in ['observe', 'backend_abort']:
                assert rows['support'] == 'requires-orchestration[host=Console; features=EffectHandler]', diagnostic(item)
                assert rows['default actions'] == {'Console.stdout_write'}, diagnostic(item)
                assert rows['requested actions'] <= {'Console.stdout_write', 'LegacyChildModel.infer', 'ReadTools.read', 'ReadTools.search', 'ConversationOutput.publish'}, diagnostic(item)
            else:
                assert rows['support'] == 'local', diagnostic(item)
                assert rows['requested actions'] == rows['default actions'] == set(), diagnostic(item)
        for flow in ['production_read', 'production_search', 'production_loop']:
            item = invoke(production, flow + '-effects', ['effects', production, '--flow', flow]); rows = action_rows(item)
            fs = 'Fs.read[nomo.tools.workspace.ReadOnlyRoot]'
            if flow != 'production_loop':
                # Bounded read handles ReadLimitError inside the production
                # implementation, so it requires the effect-handler runtime.
                assert rows['support'] == 'requires-orchestration[host=FileIO; features=EffectHandler]', diagnostic(item)
                assert rows['requested actions'] == rows['default actions'] == {fs}, diagnostic(item)
            else:
                assert rows['support'] == 'requires-orchestration[host=Agentic, Console, FileIO; features=EffectHandler]', diagnostic(item)
                required = {fs, 'Console.stdout_write', 'Agentic.infer[nomo.agent.model_tool.ToolModel.run, string]'}
                allowed = required | {'Agentic.infer[nomo.agent.model_tool.ReadFirst.run, string]', 'Agentic.infer[nomo.agent.model_tool.ReadFinal.run, string]'}
                assert required <= rows['default actions'] <= allowed, diagnostic(item)
                assert required <= rows['requested actions'] <= allowed | {'LegacyChildModel.infer', 'ReadTools.read', 'ReadTools.search', 'ConversationOutput.publish'}, diagnostic(item)
        item = invoke(positive, 'deterministic-observe', ['run', positive, '--flow', 'observe', '--allow-effects', '--budget-time', '45s', '--trace-out', folder / 'observe.trace.json'])
        assert item['exit'] == 0 and not item['stderr'], diagnostic(item)
        expected_labels = ['pure_result_and_two_stateless_implementations'] + [value['label'] for value in values]
        assert [line for line in item['stdout'].splitlines() if line.startswith('PASS ')] == ['PASS ' + value for value in expected_labels], diagnostic(item)
        observed = Counter(line for line in item['stdout'].splitlines() if line.startswith('PORT '))
        expected = Counter({('PORT ' + value['label'] + ' ' + operation): count for value in values for operation, count in value['source_counts'].items() if count})
        assert observed == expected, dict(observed=observed, expected=expected)
        result['source_interpretation_counts'] = {value['label']: value['source_counts'] for value in values}
        result['normal_trace'] = trace(folder / 'observe.trace.json', True)
        failed = invoke(positive, 'backend-abort-run', ['run', positive, '--flow', 'backend_abort', '--allow-effects', '--budget-time', '15s', '--trace-out', folder / 'abort.trace.json'])
        assert failed['exit'] != 0 and 'D2_EXPECTED_BACKEND_ABORT' in failed['stdout'] + failed['stderr'], diagnostic(failed)
        assert [line for line in failed['stdout'].splitlines() if line.startswith('PORT ')] == ['PORT backend_abort Model', 'PORT backend_abort Read'], diagnostic(failed)
        assert not any(line.startswith('PASS ') for line in failed['stdout'].splitlines()), diagnostic(failed)
        result['backend_abort_trace'] = trace(folder / 'abort.trace.json', False)
        result['backend_abort_qualification'] = 'Source backend abort propagated after real source read interpretation. No completed LoopTurn is asserted or fabricated; no native Fs fault is claimed.'
        for name, code, message in [('wrong_output', 'type::TypeMismatch', 'implementation output type does not satisfy the callable spec'),
                                    ('extra_error', 'effect::EffectOutsideDeclaredRow', 'implementation escaping effects do not satisfy the callable spec bound')]:
            project = folder / name
            item = invoke(project, name + '-check', ['--format', 'json', 'check', '--all', project])
            negative(item, project, code, message)
        for name, expected_hashes in inputs.items(): assert input_hashes(folder / name) == expected_hashes
        result.update(status='passed', native_business_counts=dict(Model=0, Fs=0, Memory=0, Approval=0, Command=0))
    except BaseException as failure:
        error = failure; result.update(status='failed', failure=repr(failure), native_business_counts=None)
    finally:
        try:
            result['resources'], valid = resources()
            if not valid: result.update(status='failed', resource_failure=True, native_business_counts=None)
        except BaseException as failure:
            valid = False; result.update(status='failed', resources=None, resource_failure=repr(failure), native_business_counts=None)
            error = error or failure
        try: save(output, result)
        except BaseException as failure: error = error or failure
    if error is not None: raise error
    assert valid, dict(status=result['status'], results_artifact=str(output), resource_failure=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args(); args.evidence_dir.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='arch-read001-', dir=args.evidence_dir))
    values, inputs = prepare(folder)
    save(folder / 'preparation.json', dict(status='prepared', driver_sha256=digest(Path(__file__)), inputs=inputs, cases=[dict(label=value['label'], source_interpretation_counts=value['source_counts']) for value in values],
        scope='Source/effects plus deterministic Console-only interpretation; production bodies/negative callables never run. No native business quota or ledger mutations.'))
    print('EVIDENCE ' + str(folder), flush=True)
    if not args.prepare_only: run(folder, values, inputs)


if __name__ == '__main__':
    main()
