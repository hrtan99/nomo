#!/usr/bin/env python3
"""D7 actual shared chat controller under deterministic source stage Handlers.

Root owns the serial selected009 lane. Only Console/Policy observation may run;
real stage adapters, three existing consumers, init/show and callable negatives
are source/effect checked. The original99/49/storage/native matrices never run.
"""
import argparse
from copy import deepcopy
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
import harness_tool_chat_contract_probe as original_contract

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'tests/fixtures/arch_chat001'
PRODUCT_HASHES = {
    'src/nomo/harness/legacy_chat_stages.es': '98579470b9175818d0e014f52e7331dd302eb71f42848a802d5d4737147fab37',
    'src/nomo/harness/harness_tool_chat_controller.es': '8c6a37348fec5f9e4b4d0aff53761a58b2f2ce6fe7f2238d215289bd722028ab',
    'src/nomo/harness/harness_tool_chat.es': 'f91365e2e70bbcaddb8db31b42c5c90f5506ac56703928d0528ef4d380164aef',
    'src/nomo/harness/harness_tool_contract.es': '442e0305b6cbf774a582ed5b01641f3dbc45216ddd9dee0926a2cd9d35423046',
    'src/nomo/harness/harness_model_tools.es': 'b0e058036e9f6520532bf0d094df76a543ce9b85230ac106047e28e75b04a254',
}
ORIGINAL_HASHES = {
    'tests/harness_tool_chat_contract_probe.py': 'd7908d6f595f64b848bd212999ea77b4f0278e62f0e44e6f097d29aeba56a38d',
    'tests/harness_tool_contract_probe.py': '51b6ac12d8b359f19da1d932961373fdbcc6a9e45e9789fbd19c075213937abd',
    'tests/fixtures/harness_tool002a/contract_probe.es': 'fd70b7defc361e6d4397c1284f1d45c8bd59572d73ac1ace3be98402dc98f547',
    'src/nomo/harness/harness_tool_chat_contract.es': 'ea1ba16b8d6588d087e317e60ef43753faab33a14c4988cd3e0accb5330f796d',
}
KEYS = ['steps', 'calls', 'tokens', 'tools', 'scan']
MAXIMUM = dict(zip(KEYS, [14, 8, 16384, 2, 8192]))
ZERO = dict.fromkeys(KEYS, 0)
DIRECT = dict(zip(KEYS, [5, 3, 6144, 0, 0]))
TOOL = dict(zip(KEYS, [7, 4, 8192, 1, 4096]))
PRIOR = ['task', 'result', 'tool', 'outcome', 'answer']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


class Source(str):
    pass


def record(name, values):
    return name + ' { ' + ', '.join(key + ' = ' + (value if isinstance(value, Source) else source_literal(value)) for key, value in values.items()) + ' }'


def event(role, kind, name='', text=''):
    return dict(role=role, kind=kind, name=name, text=text)


def ledger(value):
    return Source(record('Ledger', value))


def empty_prior():
    return dict.fromkeys(PRIOR, '')


def invocation(usage=None, prior=None, admitted=0, maximum=None):
    return dict(usage=deepcopy(ZERO if usage is None else usage), maximum=deepcopy(MAXIMUM if maximum is None else maximum),
                admitted=admitted, prior=deepcopy(empty_prior() if prior is None else prior))


def invocation_source(value):
    return Source(record('Invocation', dict(usage=ledger(value['usage']), maximum=ledger(value['maximum']),
                  admitted=value['admitted'], prior=Source(record('Previous', value['prior'])))))


def state(rows, spent=0, stopped=False):
    return dict(events=deepcopy(rows), characters=sum(len(row['name']) + len(row['text']) for row in rows), spent=spent, stopped=stopped)


def state_source(value):
    return Source(record('State', dict(events=Source('[' + ', '.join(record('Event', row) for row in value['events']) + ']'),
                  characters=value['characters'], spent=value['spent'], stopped=value['stopped'])))


def child_source(value):
    child = value['state']
    session = Source(record('Session', dict(history=state_source(child['history']), calls=child['calls'], tokens=child['tokens'], tools=child['tools'], scan=child['scan'])))
    return Source(record('LoopTurn', dict(state=session, status=value['status'])))


def seed_rows(request, prior):
    rows = [event('user', 'context', 'original', request)]
    if prior['task']:
        rows += [event('user', 'context', name, prior[name]) for name in PRIOR]
    return rows


def context(request, allowed, prior, phase='plan', task='', result='', tool='', outcome=''):
    return dict(phase=phase, request=request, task=task, result=result, tool=tool, outcome=outcome, allowed=allowed, prior=deepcopy(prior))


def context_source(value):
    return Source(record('Context', dict(value, prior=Source(record('Previous', value['prior'])))))


def child_value(request, task, prior, *, result='CHILD', tool='', outcome='complete: blue', failed=False):
    rows = seed_rows(request, prior) + [event('user', 'input', text=task), event('model', 'text', 'qwen')]
    if tool:
        raw = json.dumps(['read', 'a.txt'] if tool == 'read' else ['search', 'NEEDLE', 'a.txt'], separators=(',', ':'))
        rows += [event('model', 'request', tool, raw), event('tool', 'complete', tool, outcome), event('model', 'text', 'qwen')]
    rows.append(event('error', 'error', text='bounded refusal') if failed else event('assistant', 'final', text=result))
    calls, tools = (2, 1) if tool else (1, 0)
    return dict(state=dict(history=state(rows, calls + tools), calls=calls, tokens=calls * 2048, tools=tools, scan=tools * 4096), status=3 if failed else 0)


def add(left, right):
    return {key: left[key] + right[key] for key in KEYS}


def completed(request, task, raw_plan, selected, child):
    rows = [event('user', 'request', text=request), event('main', 'plan', text=raw_plan), event('main', 'delegate', 'child-1', task)]
    rows += deepcopy(child['state']['history']['events'])
    rows.append(event('main', 'consume', 'child-1', selected['result']))
    if selected['tool']: rows.append(event('main', 'tool', selected['tool'], selected['outcome']))
    rows.append(event('main', 'answer', text=selected['answer']))
    return dict(request=request, task=task, result=selected['result'], tool=selected['tool'], outcome=selected['outcome'], answer=selected['answer'], records=rows)


def turn_source(value):
    completion = Source('None()')
    if value['completed'] is not None:
        item = value['completed']
        completion = Source('Some(' + record('Completed', dict(item, records=Source('[' + ', '.join(record('Event', row) for row in item['records']) + ']'))) + ')')
    return Source(record('TurnResult', dict(status=value['status'], state=invocation_source(value['state']), resolved=value['resolved'], completed=completion)))


def vector(label, before=None, *, request='Q', allowed=None, task='T', result='CHILD', answer='ANSWER', tool='', outcome='complete: blue'):
    before = invocation() if before is None else deepcopy(before)
    allowed = ['a.txt'] if allowed is None else allowed
    prior = before['prior']; raw = json.dumps(['delegate', task], separators=(',', ':'))
    child = child_value(request, task, prior, result=result, tool=tool, outcome=outcome)
    selected = dict(task=task, result=result, tool=tool, outcome=outcome if tool else '', answer=answer)
    local = TOOL if tool else DIRECT
    following = invocation(add(before['usage'], local), selected, before['admitted'] + 1, before['maximum'])
    return dict(label=label, request=request, allowed=allowed, before=before,
                plan=context(request, allowed, prior), aggregate=context(request, allowed, prior, 'aggregate', task, result, tool, outcome if tool else ''),
                task=task, selected=state(seed_rows(request, prior)), child=child, raw_plan=raw, answer=answer,
                expected=dict(status=0, state=following, resolved=True, completed=completed(request, task, raw, selected, child)),
                scenario='success', error='', local=deepcopy(local), prior_result=None)


def fail_expected(item, local, *, error, unresolved=False, original_state=False, scenario):
    after = deepcopy(item['before']) if unresolved or original_state else invocation(add(item['before']['usage'], local), empty_prior(), item['before']['admitted'] + 1, item['before']['maximum'])
    item.update(expected=dict(status=1, state=after, resolved=not unresolved, completed=None), scenario=scenario, error=error, local=deepcopy(local))
    return item


def vectors():
    """Explicit full-value inputs/oracles; no host clone of run_turn logic."""
    values = []
    first = vector('direct_first', request='First direct', task='T1', result='DIRECT1', answer='ANSWER1'); values.append(first)
    second = vector('direct_second', first['expected']['state'], request='Second direct', task='T2', result='DIRECT2', answer='ANSWER2')
    second['prior_result'] = 'result_0.state'; values.append(second)
    third = vector('third_core_preserves_reservation_priority', second['expected']['state'])
    third['prior_result'] = 'result_1.state'
    values.append(fail_expected(third, ZERO, error='invocation worst-case turn reservation exhausted', original_state=True, scenario='pre_dispatch'))
    first_tool = vector('tool_first', request='First tool', task='READ1', result='BLUE', answer='ANSWER BLUE', tool='read', outcome='complete: blue<LF>'); values.append(first_tool)
    second_tool = vector('tool_second', first_tool['expected']['state'], request='Second tool', task='SEARCH2', result='MATCH', answer='ANSWER MATCH', tool='search', outcome='complete: a.txt:1<LF>')
    second_tool['prior_result'] = 'result_3.state'; values.append(second_tool)
    values.append(fail_expected(vector('invalid_request', request=''), ZERO, error='question requires 1..128 printable ASCII chars, not only spaces', scenario='pre_execute'))
    values.append(fail_expected(vector('invalid_allowlist', allowed=[]), ZERO, error='expected one or two allowed files', scenario='pre_execute'))
    malformed = invocation(prior=dict(empty_prior(), result='forged'))
    values.append(fail_expected(vector('malformed_prior', malformed), ZERO, error='invalid empty prior selection', original_state=True, scenario='pre_dispatch'))
    narrow = invocation(maximum=dict(MAXIMUM, scan=4095))
    values.append(fail_expected(vector('insufficient_worst_case_scan', narrow), ZERO, error='invocation worst-case turn reservation exhausted', original_state=True, scenario='pre_dispatch'))
    bad_plan = vector('bad_plan_attempt_retained'); bad_plan['raw_plan'] = 'not JSON'
    values.append(fail_expected(bad_plan, dict(zip(KEYS, [1, 1, 2048, 0, 0])), error='expected bounded flat single-line delegation JSON', scenario='bad_plan'))
    bad_prefix = vector('child_prefix_unresolved')
    bad_prefix['child']['state']['history']['events'][0]['text'] = 'WRONG'
    bad_prefix['child']['state']['history'] = state(bad_prefix['child']['state']['history']['events'], 1)
    values.append(fail_expected(bad_prefix, dict(zip(KEYS, [2, 1, 2048, 0, 0])), error='selected prior history changed', unresolved=True, scenario='bad_child'))
    bad_ledger = vector('child_ledger_unresolved'); bad_ledger['child']['state']['calls'] = 3
    values.append(fail_expected(bad_ledger, dict(zip(KEYS, [2, 1, 2048, 0, 0])), error='invalid child ledger', unresolved=True, scenario='bad_child'))
    failed_child = vector('settled_child_failure')
    failed_child['child'] = child_value('Q', 'T', empty_prior(), failed=True)
    values.append(fail_expected(failed_child, dict(zip(KEYS, [3, 2, 4096, 0, 0])), error='child returned failure; no aggregation', scenario='settled_child_failure'))
    bad_answer = vector('aggregate_refusal_after_charge'); bad_answer['answer'] = ''
    values.append(fail_expected(bad_answer, DIRECT, error='invalid bounded final answer', scenario='bad_answer'))
    large = dict(task='"' * 128, result='"' * 256, tool='read', outcome='complete: ' + '"' * 256, answer='"' * 512)
    oversized = vector('whole_parent_context_pre_dispatch', invocation(TOOL, large, 1), request='"' * 128)
    values.append(fail_expected(oversized, ZERO, error='model context exceeds 2048 serialized characters', scenario='pre_execute'))
    return values


def vector_source(item):
    values = {key: item[key] for key in ['label', 'request', 'allowed', 'before', 'plan', 'aggregate', 'task', 'selected', 'child', 'raw_plan', 'answer', 'expected']}
    values.update(before=invocation_source(item['before']), plan=context_source(item['plan']), aggregate=context_source(item['aggregate']),
                  selected=state_source(item['selected']), child=child_source(item['child']), expected=turn_source(item['expected']))
    return record('Vector', values)


def zero_vector_source():
    before = Source(record('Invocation', dict(usage=ledger(TOOL), maximum=ledger(MAXIMUM), admitted=1, prior=Source('prior'))))
    plan = Source(record('Context', dict(phase='plan', request='Q', task='', result='', tool='', outcome='', allowed=['a.txt'], prior=Source('prior'))))
    usage = dict(zip(KEYS, [9, 5, 10240, 1, 4096]))
    after = Source(record('Invocation', dict(usage=ledger(usage), maximum=ledger(MAXIMUM), admitted=2, prior=Source('empty()'))))
    expected = Source(record('TurnResult', dict(status=1, state=after, resolved=True, completed=Source('None()'))))
    fields = dict(label='zero_call_child_context_proven', request='Q', allowed=['a.txt'], before=before, plan=plan, aggregate=plan,
                  task='T', selected=Source('selected'), child=Source('LoopTurn { state = original.child, status = original.status }'),
                  raw_plan='["delegate","T"]', answer='UNEXPECTED aggregate', expected=expected)
    return record('Vector', fields)


def manifest(module, flows):
    prefix = '[package]\nname = "chat-stage-handler-probe"\nversion = "0.0.0"\nedition = "2026"\n[source]\nroot = "src"\n[runtime]\ndefault_profile = "fixture"\n[runtime.profiles.fixture]\nboundary_policy = "chat-no-native-business"\n[runtime.profiles.fixture.policy]\nmode = "local-static"\nrules = ["console=allow", "model=deny", "filesystem=deny", "memory=deny", "session=deny", "approval=deny", "command=deny"]\n[runtime.profiles.fixture.approval]\nmode = "deny"\n'
    return prefix + ''.join('\n[[bin]]\nname = ' + json.dumps(flow) + '\nmodule = ' + json.dumps(module) + '\nflow = ' + json.dumps(flow) + '\nprofile = "fixture"\n' for flow in flows)


def closure(module):
    pending, found = [module], {}
    while pending:
        name = pending.pop()
        if name in found: continue
        path = (ROOT / 'src').joinpath(*name.split('.')).with_suffix('.es')
        source = path.read_text()
        assert re.findall(r'^\s*module\s+([\w.]+)\s*;', source, re.M) == [name], str(path)
        found[name] = path
        for imported in re.findall(r'^\s*(?:public\s+)?import\s+(nomo(?:\.[A-Za-z_]\w*)*)[.\s;]', source, re.M):
            parts = imported.split('.')
            selected = ['.'.join(parts[:end]) for end in range(2, len(parts) + 1) if (ROOT / 'src').joinpath(*parts[:end]).with_suffix('.es').is_file()]
            assert len(selected) == 1, imported
            pending.append(selected[0])
    return found


def input_hashes(project):
    return {str(path.relative_to(project)): digest(path) for path in sorted((project / 'src').rglob('*.es'))} | {'etas.toml': digest(project / 'etas.toml')}


def prepare(folder):
    for name, expected in dict(PRODUCT_HASHES, **ORIGINAL_HASHES).items(): assert digest(ROOT / name) == expected, name
    values = vectors()
    original_values = original_contract.cases()  # Construct old inputs only; no old matrix/CLI execution.
    chosen = [source for label, source in original_values if label == 'zero_call_child_context_proven']
    assert len(chosen) == 1
    original_source = chosen[0]
    rebound = original_source.replace('Check {', 'OriginalCheck {', 1)
    assert rebound.replace('OriginalCheck {', 'Check {', 1) == original_source
    project = folder / 'controller'; (project / 'src/app').mkdir(parents=True)
    # Complete112 D7 product graph already passed root's early-source-002. This
    # check adds only the new fixture and its actual production-consumer closure.
    roots = ['nomo.harness.harness_tool_chat_controller', 'nomo.harness.harness_tool_chat',
             'nomo.harness.harness_model_tools', 'nomo.entry.harness_model_tools_chat',
             'nomo.entry.harness_checkpoint_entry', 'nomo.entry.harness_successor_entry']
    positive_sources = {}
    for module in roots: positive_sources.update(closure(module))
    for module, path in positive_sources.items():
        target = project / 'src' / path.relative_to(ROOT / 'src')
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(path, target)
    exercises = []
    for index, item in enumerate(values):
        previous = item['prior_result'] or 'values[' + str(index) + '].before'
        exercises.append('let result_' + str(index) + ' = exercise(values[' + str(index) + '], ' + previous + ');')
    source = (FIXTURES / 'controller_probe.es').read_text()
    replacements = {'__VECTORS__': '[' + ',\n'.join(map(vector_source, values)) + ']', '__EXERCISES__': '\n    '.join(exercises),
                    '__ORIGINAL_ZERO_CHECK__': rebound, '__ZERO_VECTOR__': zero_vector_source(),
                    '__ABORT_CONTEXT__': context_source(context('Q', ['a.txt'], empty_prior()))}
    for key, value in replacements.items(): source = source.replace(key, value)
    assert not re.search(r'__[A-Z_]+__', source)
    (project / 'src/app/chat_stage_probe.es').write_text(source)
    (project / 'etas.toml').write_text(manifest('app.chat_stage_probe', ['observe', 'backend_abort']))
    for name in ['wrong_output', 'extra_error']:
        negative = folder / name; (negative / 'src/app').mkdir(parents=True)
        for module, path in closure('nomo.harness.legacy_chat_stages').items():
            target = negative / 'src' / path.relative_to(ROOT / 'src'); target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(path, target)
        shutil.copyfile(FIXTURES / (name + '.es'), negative / 'src/app/callable_negative.es')
        (negative / 'etas.toml').write_text(manifest('app.callable_negative', ['main']))
    save(folder / 'original-zero-source.json', dict(original_driver_sha256=digest(Path(original_contract.__file__)),
         original_case_expression_sha256=hashlib.sha256(original_source.encode()).hexdigest(), original_case_expression=original_source,
         new_test_only_outer_name='Check -> OriginalCheck', inverse_outer_name_byte_exact=True,
         scope='Original99 inputs constructed once to select one unchanged logical expression; none of the99 old checks is executed here.'))
    return values, {name: input_hashes(folder / name) for name in ['controller', 'wrong_output', 'extra_error']}


def numbers(value):
    return ' '.join(key + '=' + str(value[key]) for key in KEYS)


def stage(turn, phase, before, local):
    steps = {'plan': 6, 'child': 5, 'aggregate': 0}[phase]
    calls = 0 if phase == 'aggregate' else 3
    tools = 0 if phase == 'aggregate' else 1
    return ('TURN ' + str(turn) + ' STAGE ' + phase + ' ' + numbers(add(before, local)) +
            ' reserved_steps=' + str(steps) + ' reserved_calls=' + str(calls) + ' reserved_tokens=' + str(calls * 2048) +
            ' reserved_tools=' + str(tools) + ' reserved_scan=' + str(tools * 4096) + '\n' +
            ('RESERVATION child-1 steps=3 calls=2 tokens=4096 tools=1 scan=4096 tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true\n' if phase == 'child' else ''))


def transcript(item):
    label, scenario = item['label'], item['scenario']
    out = 'CASE ' + label + '\n'
    if scenario in ['pre_dispatch', 'pre_execute']: return out + 'REFUSED ' + item['error'] + '\nPASS ' + label + '\n'
    turn = item['before']['admitted'] + 1; before = item['before']['usage']
    out += stage(turn, 'plan', before, dict(zip(KEYS, [1, 1, 2048, 0, 0]))) + 'PORT ' + label + ' main.plan\n'
    if scenario == 'bad_plan': return out + 'REFUSED ' + item['error'] + '\nPASS ' + label + '\n'
    out += 'EVENT main -> child-1 request child-1: ' + item['task'] + '\n'
    out += stage(turn, 'child', before, dict(zip(KEYS, [2, 1, 2048, 0, 0]))) + 'PORT ' + label + ' child\n'
    if scenario == 'bad_child': return out + 'REFUSED ' + item['error'] + '\nRESERVATION child-1 unresolved=true; returned child metadata refused\nPASS ' + label + '\n'
    local = dict(zip(KEYS, [2, 1, 2048, 0, 0])) if scenario == 'zero_child' else dict(zip(KEYS, [5, 3, 6144, 1, 4096])) if item.get('aggregate', {}).get('tool') else dict(zip(KEYS, [3, 2, 4096, 0, 0]))
    out += ('SETTLED child-1 ' + numbers(add(before, local)) + ' released_steps=' + str(5 - local['steps']) + ' released_calls=' +
            str(3 - local['calls']) + ' released_tokens=' + str(6144 - local['tokens']) + ' released_tools=' + str(1 - local['tools']) +
            ' released_scan=' + str(4096 - local['scan']) + ' unresolved=false\n')
    if scenario in ['settled_child_failure', 'zero_child']: return out + 'REFUSED ' + item['error'] + '\nPASS ' + label + '\n'
    aggregate = item['aggregate']
    out += 'EVENT child-1 -> main result child-1: ' + aggregate['result'] + '\nEVENT main -> main consume child-1: ' + aggregate['result'] + '\n'
    if aggregate['tool']: out += 'EVENT main -> main tool ' + aggregate['tool'] + ': ' + aggregate['outcome'] + '\n'
    out += stage(turn, 'aggregate', before, item['local']) + 'PORT ' + label + ' main.aggregate\n'
    out += ('REFUSED ' + item['error']) if scenario == 'bad_answer' else ('FINAL ' + item['answer'])
    return out + '\nPASS ' + label + '\n'


def zero_transcript():
    return transcript(dict(label='zero_call_child_context_proven', scenario='zero_child', before=dict(admitted=1, usage=TOOL),
                           task='T', error='child returned failure; no aggregation'))


def environment():
    names = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CARGO_HOME', 'CARGO_TARGET_DIR']
    return {name: os.environ[name] for name in names if name in os.environ} | dict(NOMO_NORMAL_GRAPH='latest', ETAS_HOST_FILESYSTEM='none',
        ETAS_HOST_MEMORY='none', ETAS_HOST_SESSION='none', ETAS_HOST_APPROVAL='deny')


def row_set(value):
    assert value.startswith('[') and value.endswith(']'), 'malformed effect row'
    parts = re.findall(r'[A-Za-z_][A-Za-z0-9_.]*(?:<[^<>]+>|\[[^\[\]]+\])?', value[1:-1])
    assert value == '[' + ', '.join(parts) + ']' and len(parts) == len(set(parts)), 'malformed/duplicate action row'
    return set(parts)


def has_agent(actions, owner):
    # Source owner identity is exact; compiler renderers may expose its generated run.
    return any(value in actions for value in ['Agentic.infer[' + owner + '.run, string]', 'Agentic.infer[' + owner + ', string]'])


def audit_effects(report):
    assert report['command'] == 'effects' and not report['diagnostics'], 'full graph effect diagnostics'
    items = report['items']; result = {}
    def selected(name, kind='flow'):
        rows = [item for item in items if item['name'] == name and item['kind'] == kind]
        assert len(rows) == 1, 'missing/ambiguous effects: ' + name
        item = rows[0]
        rows = {key: row_set(item[key]) for key in ['escaping_effects', 'requested_actions', 'default_actions']}
        assert 'rejected' not in item['support'].lower() and not any('Unresolved' in text for text in item['residual_checks']), name
        result[name] = dict(rows={key: sorted(value) for key, value in rows.items()}, support=item['support'], requirements=item['requirements'])
        return rows
    custom = {'LegacyChatStages.main', 'LegacyChatStages.child'}
    controller = selected('run_turn_controller')
    assert custom | {'Console.stdout_write'} == controller['requested_actions'], 'controller requested stages/Console'
    assert controller['default_actions'] == {'Console.stdout_write'}, 'controller default Console'
    assert custom <= controller['escaping_effects'], 'controller unhandled stage escapes'
    observed = selected('observe')
    assert custom | {'Console.stdout_write'} == observed['requested_actions'] and observed['default_actions'] == {'Console.stdout_write'}, 'source Handler operation boundary'
    assert not custom.intersection(observed['escaping_effects']), 'handled source stage escapes'
    pure = selected('numbers_probe')
    assert pure['requested_actions'] == pure['default_actions'] == set(), 'numbers alias introduced Host request'
    main = selected('ChatMain', 'agent')
    assert main['escaping_effects'] == set(), 'native ChatMain callable escaping row'
    assert has_agent(main['requested_actions'], 'nomo.harness.harness_tool_chat.ChatMain'), 'actual ChatMain Agent identity'
    assert has_agent(main['default_actions'], 'nomo.harness.harness_tool_chat.ChatMain'), 'native ChatMain default action'
    fs = 'Fs.read[nomo.tools.workspace.ReadOnlyRoot]'
    child = selected('production_child')
    assert fs in child['requested_actions'] and fs in child['default_actions'] and 'Console.stdout_write' in child['default_actions'], 'child concrete read/Console adapter'
    assert any(has_agent(child['requested_actions'], 'nomo.agent.model_tool.' + owner) for owner in ['ToolModel', 'ReadFirst', 'ReadFinal']), 'child native Agent identity'
    assert child['escaping_effects'] <= {'Error<std.io.IOError>', 'Error<std.fs.IOError>', 'Error<std.runtime.error.IndexError>'}, 'child declared allowed escaping row'
    child_impl = selected('child_turn')
    assert child_impl == child, 'direct child adapter and call wrapper rows differ'
    for name in ['run_turn', 'production_facade', 'entry_checkpoint_save', 'entry_successor_continue', 'entry_chat']:
        rows = selected(name)
        assert custom <= rows['requested_actions'] and not custom.intersection(rows['escaping_effects']), name + ' production stage interpretation'
        assert has_agent(rows['requested_actions'], 'nomo.harness.harness_tool_chat.ChatMain'), name + ' native main action'
        assert fs in rows['requested_actions'] and fs in rows['default_actions'] and 'Console.stdout_write' in rows['default_actions'], name + ' production concrete actions'
        if name == 'production_facade': assert any('2048' in text for text in result[name]['requirements']), 'actual ChatMain/child 2048 invocation requirement'
    for name in ['entry_checkpoint_init', 'entry_checkpoint_show', 'entry_successor_show']:
        rows = selected(name)
        assert not any(value.startswith(('Agentic.', 'Model.', 'LegacyChatStages.', 'LegacyChildModel.', 'Fs.')) for value in rows['requested_actions']), name + ' gained Model/child/File'
        if name != 'entry_checkpoint_init': assert not any(value.startswith('Memory.write') for value in rows['requested_actions']), name + ' show writes'
    return result


def trace(path, completed, writes):
    value = json.loads(path.read_text())
    assert value['schema'] == 'etas.cli.interpreter-report.v1' and not value.get('incomplete', False)
    assert value['outcome']['kind'] == ('completed' if completed else 'failed') and value['termination']['local_work_settled'] is True
    starts = [item for item in value['events'] if item['kind'] == 'host_request_started']; finishes = [item for item in value['events'] if item['kind'] == 'host_request_finished']
    ids = [item['id'] for item in starts]; ends = [item['id'] for item in finishes]
    assert len(ids) == len(set(ids)) and len(ends) == len(set(ends)) and len(ids) == len(ends) and set(ids) == set(ends)
    assert all(item['outcome']['kind'] == 'succeeded' for item in finishes)
    assert all(item['qualified_action'] in ['Policy.evaluate', 'Console.stdout_write'] for item in starts)
    assert sum(item['qualified_action'] == 'Console.stdout_write' for item in starts) == writes
    return dict(settled=True, unique_paired_requests=len(starts), Console_stdout_write=writes, native_Model_Fs_Memory_Approval_Command=0)


def negative(item, project, code, message):
    assert item['exit'] != 0 and not item['stderr'], item['label']
    report = json.loads(item['stdout']); assert report['command'] == 'check'
    diagnostics = [(Path(file['path']).resolve(), value) for file in report['files'] for value in file['diagnostics']]
    assert len(diagnostics) == 1, item['label'] + ': expected sole callable diagnostic'
    path, value = diagnostics[0]; source = project / 'src/app/callable_negative.es'
    line = next(i for i, text in enumerate(source.read_text().splitlines(), 1) if text.startswith('flow bad('))
    assert path == source.resolve() and value['severity'] == 'error' and value['code'] == code and value['message'] == message, item['label']
    assert value['primary']['span']['startLine'] == line, item['label']


def run(folder, values, inputs):
    cli = verify_cli()
    result = dict(task='D7 same-controller source stage controls', status='running', commands=[], effects=None, traces={}, inputs=inputs,
                  qualification='All ports interpreted in source. Only Console/Policy test transport may execute; no native Model/File/Memory/Approval/Command/SSH/storage/PTY or real Qwen. Original consumed quotas are untouched.')
    output = folder / 'results.json'; save(output, result); error = None
    try:
        def invoke(project, label, args):
            assert input_hashes(project) == inputs[project.name], label
            command = list(map(str, [cli, '--no-config', *args])); item = dict(label=label, command=command); result['commands'].append(item); save(output, result)
            observed = subprocess.run(command, capture_output=True, input=b'', env=environment(), timeout=120)
            (folder / (label + '.stdout.bin')).write_bytes(observed.stdout); (folder / (label + '.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode()); save(output, result)
            return item
        project = folder / 'controller'
        item = invoke(project, 'fixture-closure-source-check', ['check', '--all', project])
        assert item['exit'] == 0 and not item['stderr'] and item['stdout'] == 'checked ' + str(len(inputs['controller']) - 1) + ' files\n', 'fixture-closure-source-check: preserved raw diagnostics'
        item = invoke(project, 'full-effect-facts', ['--format', 'json', 'effects', project])
        assert item['exit'] == 0 and not item['stderr'], 'full-effect-facts: preserved raw diagnostics'
        result['effects'] = audit_effects(json.loads(item['stdout'])); save(output, result)
        expected = 'PASS numbers_canonical_and_legacy\n' + ''.join(map(transcript, values)) + zero_transcript()
        item = invoke(project, 'source-stage-observe', ['run', project, '--flow', 'observe', '--allow-effects', '--budget-time', '40s', '--trace-out', folder / 'observe.trace.json'])
        assert item['exit'] == 0 and not item['stderr'] and item['stdout'] == expected, 'source-stage-observe: exact transcript/whole-value oracle; see preserved raw artifacts'
        ports = [line for line in item['stdout'].splitlines() if line.startswith('PORT ')]
        wanted = []
        for value in values:
            if value['scenario'] not in ['pre_dispatch', 'pre_execute']:
                wanted.append('PORT ' + value['label'] + ' main.plan')
                if value['scenario'] != 'bad_plan': wanted.append('PORT ' + value['label'] + ' child')
                if value['scenario'] in ['success', 'bad_answer']: wanted.append('PORT ' + value['label'] + ' main.aggregate')
        wanted += ['PORT zero_call_child_context_proven main.plan', 'PORT zero_call_child_context_proven child']
        assert ports == wanted, 'ordered source port-call tape differs'
        result['source_port_tape'] = ports
        result['traces']['observe'] = trace(folder / 'observe.trace.json', True, expected.count('\n'))
        aborted = invoke(project, 'source-stage-abort', ['run', project, '--flow', 'backend_abort', '--allow-effects', '--budget-time', '10s', '--trace-out', folder / 'abort.trace.json'])
        abort_prefix = 'CASE source_abort\n' + stage(1, 'plan', ZERO, dict(zip(KEYS, [1, 1, 2048, 0, 0]))) + 'PORT source_abort main.plan\n'
        assert aborted['exit'] != 0 and aborted['stdout'].startswith(abort_prefix) and 'D7_EXPECTED_SOURCE_STAGE_ABORT' in aborted['stdout'] + aborted['stderr'], 'source-stage-abort'
        assert 'UNREACHABLE' not in aborted['stdout'] + aborted['stderr'] and 'FINAL ' not in aborted['stdout'] and 'SETTLED ' not in aborted['stdout'], 'source-stage-abort invented outcome'
        result['traces']['abort'] = trace(folder / 'abort.trace.json', False, abort_prefix.count('\n'))
        for name, code, message in [('wrong_output', 'type::TypeMismatch', 'implementation output type does not satisfy the callable spec'),
                                    ('extra_error', 'effect::EffectOutsideDeclaredRow', 'implementation escaping effects do not satisfy the callable spec bound')]:
            negative_project = folder / name
            item = invoke(negative_project, name + '-check', ['--format', 'json', 'check', '--all', negative_project]); negative(item, negative_project, code, message)
        for name, expected_inputs in inputs.items(): assert input_hashes(folder / name) == expected_inputs, name
        result.update(status='passed', vectors=len(values) + 1, double_turn_groups=['direct/direct', 'tool/tool'], native_Model_Fs_Memory_Approval_Command=0)
    except BaseException as failure:
        error = failure; result.update(status='failed', failure_class=type(failure).__name__, failure=str(failure))
    finally:
        try:
            result['resources'], valid = resources()
            if not valid: result.update(status='failed', resource_failure=True)
        except BaseException as failure:
            valid = False; result.update(status='failed', resource_failure=type(failure).__name__); error = error or failure
        save(output, result)
    if error is not None: raise error
    assert valid, str(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True); parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args(); args.evidence_dir.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='chat-stage-handler-', dir=args.evidence_dir)); print('EVIDENCE ' + str(folder), flush=True)
    values, inputs = prepare(folder)
    save(folder / 'preparation.json', dict(status='prepared', inputs=inputs, driver_sha256=digest(Path(__file__)),
         cases=[dict(label=value['label'], scenario=value['scenario'], actual_previous_result=value['prior_result']) for value in values],
         original_zero_case='one exact old Check expression, outer test-only name conversion only',
         qualification='Source construction only until root runs the selected compiler in its serial ordinary lane. No old matrix, native stage or durable lifecycle starts here.'))
    if not args.prepare_only: run(folder, values, inputs)


if __name__ == '__main__':
    main()
