#!/usr/bin/env python3
"""Synthetic defensive contract inputs, not additional real model/File calls."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
MODULES = ['harness/harness_tool_contract.es', 'harness/harness_model_contract.es',
           'model/model_tool_contract.es', 'core/text.es', 'core/conversation.es', 'tools/path_policy.es']


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def record(name, **fields):
    return name + ' { ' + ', '.join(key + ' = ' + value for key, value in fields.items()) + ' }'


def ledger(steps=0, calls=0, tokens=0, tools=0, scan=0):
    return record('Ledger', **{key: str(value) for key, value in zip(
        ['steps', 'calls', 'tokens', 'tools', 'scan'], [steps, calls, tokens, tools, scan])})


def observed(result='', tool='', outcome=''):
    return record('Observed', result=encoded(result), tool=encoded(tool), outcome=encoded(outcome))


def event(role, kind, name='', text=''):
    return 'event(' + ', '.join(encoded(value) for value in [role, kind, name, text]) + ')'


def child(events, spent=1, calls=1, tokens=2048, tools=0, scan=0):
    return 'sample([' + ', '.join(events) + '], ' + ', '.join(map(str, [spent, calls, tokens, tools, scan])) + ')'


def context(**changes):
    value = dict(phase='plan', request='', task='', result='', tool='', outcome='', allowed=['a.txt'])
    value.update(changes)
    return value, record('Context', **{key: encoded(item) for key, item in value.items()})


def cases():
    values = []
    prefix = [event('user', 'context', 'original', 'Q'), event('user', 'input', text='T'), event('model', 'text', 'qwen')]
    direct = prefix + [event('assistant', 'final', text='CHILD')]
    request = event('model', 'request', 'read', encoded(['read', 'a.txt']))
    complete = event('tool', 'complete', 'read', 'complete: ')
    tool = prefix + [request, complete]
    terminal = event('error', 'error', text='bounded refusal')
    parent = ledger(2, 1, 2048)
    def add(label, mode='inspect', accepted=True, **changes):
        fields = dict(label=encoded(label), mode=encoded(mode), ledger=parent, child=child(direct), status='0',
                      context=context()[1], accepted=str(accepted).lower(), expected_ledger=ledger(), expected_observed=observed())
        fields.update(changes)
        values.append((label, record('Check', **fields)))
    canonical = [
        ('direct', direct, (1, 1, 2048, 0, 0), 0, observed('CHILD')),
        ('first_protocol_refusal', prefix + [terminal], (1, 1, 2048, 0, 0), 3, observed()),
        ('tool_refusal', prefix + [request, event('tool', 'error', 'read', 'refused: bounded')], (2, 1, 2048, 1, 4096), 3, observed()),
        ('second_context_refusal', tool + [terminal], (2, 1, 2048, 1, 4096), 4, observed()),
        ('tool_success_empty_complete', tool + [event('model', 'text', 'qwen'), event('assistant', 'final', text='CHILD')],
         (3, 2, 4096, 1, 4096), 0, observed('CHILD', 'read', 'complete: ')),
        ('second_protocol_refusal', tool + [event('model', 'text', 'qwen'), terminal], (3, 2, 4096, 1, 4096), 3, observed())]
    for name, events, counts, status, wanted in canonical:
        sample = child(events, *counts)
        add(name, child=sample, status=str(status), expected_observed=wanted)
        spent, calls, tokens, tools, scan = counts
        add('settle_' + name, mode='settle', child=sample,
            expected_ledger=ledger(2 + spent, 1 + calls, 2048 + tokens, tools, scan))
    for size in [257, 512]:
        sample = child(prefix + [event('assistant', 'final', text='x' * size)])
        add('canonical_final_' + str(size), child=sample, expected_observed=observed('x' * size))
        add('settle_before_parent_final_bound_' + str(size), mode='settle', child=sample, expected_ledger=ledger(3, 2, 4096))
    failure = child(prefix + [request, event('tool', 'error', 'read', 'truncated: ' + 'x' * 256)], 2, 1, 2048, 1, 4096)
    add('ordinary_tool_error_267_not_complete_bound', child=failure, status='3')
    for label, counts in [('zero_spent', (0, 1, 2048, 0, 0)), ('zero_call', (1, 0, 0, 0, 0)),
                          ('three_calls', (3, 3, 6144, 0, 0)), ('bad_tokens', (1, 1, 2047, 0, 0)),
                          ('two_tools', (3, 1, 2048, 2, 8192)), ('bad_scan', (1, 1, 2048, 0, 1)),
                          ('inconsistent_spent', (3, 1, 2048, 0, 0)), ('large_call_range_first', (1, 2147483647, 0, 0, 0))]:
        add(label, accepted=False, child=child(direct, *counts))
    add('wrong_original', accepted=False, child=child([event('user', 'context', 'original', 'WRONG')] + direct[1:]))
    add('wrong_task', accepted=False, child=child([prefix[0], event('user', 'input', text='WRONG')] + direct[2:]))
    add('wrong_character_count', accepted=False, child='changed(' + child(direct) + ', 0, false)')
    add('stopped_child', accepted=False, child='changed(' + child(direct) + ', 19, true)')
    add('unknown_return_status', accepted=False, status='4')
    add('unallowed_tool_request', accepted=False, child=child(prefix + [event('model', 'request', 'read', encoded(['read', 'other.txt'])),
        complete, event('model', 'text', 'qwen'), event('assistant', 'final', text='CHILD')], 3, 2, 4096, 1, 4096))
    add('bad_completion_prefix', accepted=False, child=child(prefix + [request, event('tool', 'complete', 'read', 'fake: data'),
        event('model', 'text', 'qwen'), event('assistant', 'final', text='CHILD')], 3, 2, 4096, 1, 4096))
    for label, supplied, mode, wanted in [
        ('first_parent_call', ledger(), 'call', ledger(1, 1, 2048)),
        ('direct_parent_tail_call', ledger(4, 2, 4096), 'call', ledger(5, 3, 6144)),
        ('one_tool_parent_tail_call', ledger(6, 3, 6144, 1, 4096), 'call', ledger(7, 4, 8192, 1, 4096)),
        ('overflow_steps_range_first', ledger(2147483647), 'call', None),
        ('overflow_calls_range_first', ledger(0, 2147483647), 'call', None),
        ('negative_tokens', ledger(2, 1, -1), 'call', None),
        ('third_boundary', ledger(6, 3, 6144, 1, 4096), 'boundary', None),
        ('exhausted_call', ledger(7, 4, 8192, 1, 4096), 'call', None)]:
        add(label, mode=mode, ledger=supplied, accepted=wanted is not None, expected_ledger=wanted or ledger())
    add('unowned_parent_fresh', mode='settle', ledger=ledger(), accepted=False)
    add('unowned_parent_plan', mode='settle', ledger=ledger(1, 1, 2048), accepted=False)
    raw, _ = context()
    overhead = len(encoded(raw))
    for quoted in [False, True]:
        delta = 2048 - overhead
        text = ('x' * delta) if not quoted else ('x' * (delta % 2) + '"' * (delta // 2))
        for extra in [0, 1]:
            raw, expression = context(request=text + 'x' * extra)
            assert len(encoded(raw)) == 2048 + extra
            add(('quoted' if quoted else 'plain') + '_context_' + str(2048 + extra), mode='context', context=expression, accepted=extra == 0)
    add('ordinary_context', mode='context')
    assert 0 < len(values) <= 64 and len(values) == len({label for label, _ in values})
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--etas', required=True, type=Path)
    parser.add_argument('--evidence-dir', required=True, type=Path)
    args = parser.parse_args()
    cli = verify_cli()
    assert cli.resolve() == args.etas.resolve()
    evidence = Path(tempfile.mkdtemp(prefix='tool-contract-', dir=args.evidence_dir))
    print('EVIDENCE ' + str(evidence), flush=True)
    project = evidence / 'project'
    source_inputs = {}
    for name in MODULES:
        source = ROOT / 'src/nomo' / name
        target = project / 'src/nomo' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        source_inputs[str(source.relative_to(ROOT))] = hashlib.sha256(source.read_bytes()).hexdigest()
    values = cases()
    template = ROOT / 'tests/fixtures/harness_tool001/contract_probe.es'
    observer = project / 'src/app/contract_probe.es'; observer.parent.mkdir(parents=True)
    observer.write_text(template.read_text().replace('__CHECKS__', '[' + ',\n'.join(body for _, body in values) + ']'))
    (project / 'etas.toml').write_text('''[package]
name = "harness-tool-contract-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "harness-tool-contract-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.contract_probe"
flow = "observe"
profile = "fixture"
''')
    result = {'scope': 'pure synthetic ledger/history/context defenses; not model/File executions',
              'status': 'running', 'checks': [name for name, _ in values], 'sources': source_inputs, 'commands': []}
    output = evidence / 'results.json'
    for name, arguments in [('check', ['check', '--all', str(project)]),
                            ('pure-effects', ['effects', str(project), '--flow', 'pure_probe']),
                            ('observe', ['run', str(project), '--flow', 'observe', '--allow-effects'])]:
        inputs = {str(p.relative_to(project)): hashlib.sha256(p.read_bytes()).hexdigest() for p in project.rglob('*') if p.is_file()}
        command = [str(cli), *arguments]
        item = {'label': name, 'command': command, 'inputs': inputs}; result['commands'].append(item)
        output.write_text(json.dumps(result, indent=2))
        run = subprocess.run(command, capture_output=True, timeout=120)
        (evidence / (name + '.stdout.bin')).write_bytes(run.stdout)
        (evidence / (name + '.stderr.bin')).write_bytes(run.stderr)
        item.update(exit=run.returncode, stdout=run.stdout.decode(), stderr=run.stderr.decode())
        if run.returncode != 0:
            result['status'] = 'failed'; output.write_text(json.dumps(result, indent=2)); raise AssertionError(item)
        assert not run.stderr
        if name == 'pure-effects':
            assert 'requested actions: []' in run.stdout.decode() and 'default actions: []' in run.stdout.decode()
        if name == 'observe':
            assert run.stdout.decode().splitlines() == ['PASS ' + label for label, _ in values]
        output.write_text(json.dumps(result, indent=2))
    assert all(hashlib.sha256((ROOT / p).read_bytes()).hexdigest() == value for p, value in source_inputs.items())
    result['status'] = 'passed'; output.write_text(json.dumps(result, indent=2))
    print('PASS ' + str(len(values)) + ' pure tool-child contract checks; no model/File authority', flush=True)


if __name__ == '__main__': main()
