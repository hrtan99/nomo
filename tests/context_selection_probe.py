#!/usr/bin/env python3
"""Closed Context/string capacity and whole-event selection; generic numeric input remains unsupported."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from harness_checkpoint_contract_probe import MANIFEST, source_literal
from model_protocol_probe import resources
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/context_preflight001/concrete_probe.es'
MODULES = ['context/preflight.es', 'context/selection.es', 'core/conversation.es',
           'model/tool_context.es', 'tools/path_policy.es']


def wire(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def size(value):
    return len(wire(value).encode('utf-8'))


def literal(value):
    return source_literal(value)


def record(name, value):
    return name + ' { ' + ', '.join(key + ' = ' + literal(item) for key, item in value.items()) + ' }'


def event(text, role='model', kind='text', name='qwen'):
    return dict(role=role, kind=kind, name=name, text=text)


def context(events, allowed=None, final_only=False):
    return dict(history=events, allowed=['docs/a.txt'] if allowed is None else allowed,
                final_only=final_only)


def source_context(value):
    return ('Context { history = [' + ', '.join(record('Event', item) for item in value['history']) +
            '], allowed = ' + literal(value['allowed']) + ', final_only = ' + literal(value['final_only']) + ' }')


def policies(names):
    return '[' + ', '.join('EventPolicy.' + name for name in names) + ']'


def cases():
    checks = []

    def add(label, *expressions):
        checks.append((label, ' && '.join(expressions)))

    def measured(raw, maximum=None):
        encoded = wire(raw)
        return 'measured(' + ', '.join(map(literal, [raw, encoded, len(encoded.encode()),
                                                    len(encoded.encode()) if maximum is None else maximum])) + ')'

    def refused(raw, maximum, reason='TooLarge'):
        return 'measure_refused(' + literal(raw) + ', ' + str(maximum) + ', Refusal.' + reason + ')'

    def chosen(value, names, maximum, kept, omitted):
        projected = dict(value, history=[value['history'][index] for index in kept])
        return ('chosen(' + source_context(value) + ', ' + policies(names) + ', ' + str(maximum) + ', ' +
                source_context(projected) + ', ' + literal(kept) + ', ' + literal(omitted) + ', ' + str(size(projected)) + ')')

    def invalid(value, names, reason='InvalidPolicy', maximum=262144):
        return ('selection_refused(' + source_context(value) + ', ' + policies(names) + ', ' + str(maximum) +
                ', SelectionRefusal.' + reason + ')')

    add('whole_value_ascii_exact_limits', measured('task'), refused('task', size('task') - 1))
    add('utf8_actual_bytes_not_scalar_count', measured('雪'), refused('雪', 4), measured('😀'), refused('😀', 5))
    add('json_quote_backslash_and_control_expansion', *[measured(value) for value in ['"', '\\', '\n', '\r\n', '\t', '雪😀\n"\\']])
    add('zero_and_hard_maximum_bounds', refused('', 0), refused('x', 262145, 'InvalidLimit'), measured('x', 262144))
    add('empty_and_space_values_preserved', *[measured(value) for value in ['', ' ', '  task  ']])

    task = event('Do the complete task', 'user', 'input', '')
    base = context([task])
    add('task_baseline_exact_capacity', chosen(base, ['Task'], size(base), [0], []),
        invalid(base, ['Task'], 'RequiredTooLarge', size(base) - 1))
    add('no_required_value_fits_zero', invalid(base, ['Task'], 'RequiredTooLarge', 0))

    binding = dict(id='edit-1', workspace='fixture-v1', region='nomo.tools.edit_file.EditableRoot',
                   path='docs/a.txt', request_digest='a' * 64, before_digest='b' * 64,
                   after_digest='c' * 64, before_bytes=4, after_bytes=5)
    binding_text = context([task, event(wire(binding), 'user', 'context', 'binding')])
    large_integer_text = context([task, event('{"integer":9007199254740993}', 'user', 'context', 'binding')])
    add('closed_context_literal_numeric_binding_json_is_text',
        chosen(binding_text, ['Task', 'EditBinding'], size(binding_text), [0, 1], []),
        chosen(large_integer_text, ['Task', 'EditBinding'], size(large_integer_text), [0, 1], []))
    required = context([task, event('confirmed parent: task/result/tool/outcome/answer', 'user', 'context', 'parent'),
                        event('complete: the full tool result\r\n雪', 'tool', 'complete', 'read'),
                        event('old\r\n"\\雪', 'user', 'context', 'original'),
                        event(wire(binding), 'user', 'context', 'binding'),
                        event('confirmed full outcome', 'assistant', 'final', ''),
                        event('pinned extra event')])
    required_names = ['Task', 'ConfirmedParent', 'ToolOutcome', 'EditOriginal', 'EditBinding', 'ConfirmedOutcome', 'Required']
    add('every_required_reason_is_indivisible', chosen(required, required_names, size(required), list(range(7)), []),
        invalid(required, required_names, 'RequiredTooLarge', size(required) - 1))
    add('required_bytes_include_escaping_metadata', invalid(required, required_names, 'RequiredTooLarge',
                                                          sum(len(row['text']) for row in required['history'])))

    mixed = context([event('before'), task, event('after')], ['docs/a.txt', 'docs/b.txt'], True)
    add('optional_keeps_original_order_and_context_metadata', chosen(mixed, ['Optional', 'Task', 'Optional'], size(mixed), [0, 1, 2], []))
    add('required_baseline_with_explicit_omissions', chosen(mixed, ['Optional', 'Task', 'Optional'], size(context([task], mixed['allowed'], True)), [1], [0, 2]))
    skip = context([event('x' * 1024), task, event('s')])
    skip_limit = size(context([task, skip['history'][2]]))
    add('large_optional_does_not_block_later_complete_event', chosen(skip, ['Optional', 'Task', 'Optional'], skip_limit, [1, 2], [0]))
    equal = context([task, event('a'), event('b')])
    one_limit = size(context(equal['history'][:2]))
    add('equal_size_optional_tie_uses_source_order', chosen(equal, ['Task', 'Optional', 'Optional'], one_limit, [0, 1], [2]))
    add('stable_context_measurement_and_omissions', 'repeatable(' + source_context(skip) + ', ' + policies(['Optional', 'Task', 'Optional']) + ', ' + str(skip_limit) + ')')
    escaped = context([event('雪😀\n\r\n"\\  ', 'user', 'input', ''), event('literal \\n is distinct from LF\n')])
    add('whole_event_unicode_line_endings_and_literal_backslash', chosen(escaped, ['Task', 'Optional'], size(escaped), [0, 1], []))

    protected = [event('original', 'user', 'context', 'original'), event('task', 'user', 'input', ''),
                 event('complete: all data', 'tool', 'complete', 'read'), event('error: all data', 'tool', 'error', 'read'),
                 event('confirmed answer', 'assistant', 'final', '')]
    add('known_task_tool_and_final_cannot_be_optional', *[invalid(context([task, value]), ['Task', 'Optional']) for value in protected])
    add('policy_alignment_and_task_required', invalid(base, []), invalid(base, ['Required']),
        invalid(context([event('optional')]), ['Optional']), invalid(context([]), []))
    add('invalid_allowed_metadata_refused', *[invalid(context([task], names), ['Task'], 'InvalidContext')
                                             for names in [[], ['../escape'], ['docs/a.txt', 'docs/a.txt'], ['a', 'b', 'c']]])
    add('invalid_limit_is_not_optional_omission', invalid(mixed, ['Optional', 'Task', 'Optional'], 'InvalidLimit', 262145))
    maximum = context([task] + [event('x') for _ in range(31)])
    add('event_capacity_32_exact_33_refused', chosen(maximum, ['Task'] + ['Required'] * 31, size(maximum), list(range(32)), []),
        invalid(context(maximum['history'] + [event('x')]), ['Task'] + ['Required'] * 32))
    text_limit = context([event('雪' * 8192, 'user', 'input', '')])
    add('event_text_scalar_bound_preserves_all_utf8', chosen(text_limit, ['Task'], size(text_limit), [0], []),
        invalid(context([event('x' * 8193, 'user', 'input', '')]), ['Task'], 'InvalidContext'))
    fields = [context([event('task', 'x' * 129, 'input', '')]),
              context([event('task', 'user', 'x' * 129, '')]),
              context([event('task', 'user', 'input', 'x' * 129)])]
    exact = context([event('task', 'user', 'input', 'x' * 128)])
    add('event_metadata_bounds_are_explicit', chosen(exact, ['Task'], size(exact), [0], []),
        *[invalid(value, ['Task'], 'InvalidContext') for value in fields])
    empty = context([], ['docs/a.txt', 'docs/b.txt'], True)
    add('closed_context_direct_measurement_exact_capacity',
        'context_measured(' + source_context(empty) + ', ' + str(size(empty)) + ', ' + str(size(empty)) + ')',
        'context_measured(' + source_context(required) + ', ' + str(size(required)) + ', ' + str(size(required)) + ')',
        'context_refused(' + source_context(base) + ', ' + str(size(base) - 1) + ', Refusal.TooLarge)')
    direct_invalid = [context([task], []), context(maximum['history'] + [event('x')]),
                      context([event('x' * 8193, 'user', 'input', '')]), *fields]
    add('closed_context_guard_runs_without_selector',
        *['context_refused(' + source_context(value) + ', 262144, Refusal.InvalidContext)' for value in direct_invalid],
        'context_refused(' + source_context(base) + ', 262145, Refusal.InvalidLimit)')
    add('text_scalar_input_bound_is_not_encoded_byte_budget', measured('雪' * 8192),
        refused('x' * 8193, 262144, 'InvalidText'), refused('雪' * 8192, 8192))
    assert len(checks) == 26 and len({label for label, _ in checks}) == len(checks)
    return checks


def effect_contract(stdout, actions):
    expected = '[' + ', '.join(actions) + ']'
    for name in ['requested actions', 'default actions']:
        values = re.findall(r'^\s*' + name + r': (.+)$', stdout, re.M)
        assert values == [expected], (name, values)
    assert 'rejected' not in stdout.lower(), stdout
    assert 'UnresolvedEffect' not in stdout, stdout


def pure(evidence, prepare_only):
    checks = cases()
    project = evidence / 'project'
    (project / 'src/app').mkdir(parents=True)
    sources = {}
    for name in MODULES:
        source = ROOT / 'src/nomo' / name
        target = project / 'src/nomo' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        sources[str(source.relative_to(ROOT))] = hashlib.sha256(source.read_bytes()).hexdigest()
    expressions = ['Check { label = ' + literal(label) + ', passed = ' + expression + ' }' for label, expression in checks]
    template = FIXTURE.read_text()
    assert template.count('__CHECKS__') == 1
    (project / 'src/app/contract_probe.es').write_text(template.replace('__CHECKS__', '[' + ',\n'.join(expressions) + ']'))
    (project / 'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe', 'context-selection-contract-probe'))
    result = dict(task='CONTEXT-PREFLIGHT-001A-closed-pure', status='prepared', checks=[label for label, _ in checks],
                  sources=sources, fixture_sha256=hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
                  runner_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), commands=[],
                  qualification='Concrete Context/string capacity and whole-event selection only.22 original relevant context/string groups retained plus4 new closed-contract groups; original generic23/Binding387 suite remains unchanged and OPEN. No generic numeric/bytes/enum input claim, caller integration, Model, admission, storage, File, Provider token measurement or receipt authority')
    output = evidence / 'results.json'
    save = lambda: output.write_text(json.dumps(result, indent=2) + '\n')
    save()
    if prepare_only:
        return
    try:
        cli = verify_cli()
        trace = evidence / 'observe.trace.json'
        commands = [('check', [cli, 'check', '--all', project]),
                    ('pure-effects', [cli, 'effects', project, '--flow', 'pure_probe']),
                    ('observe-effects', [cli, 'effects', project, '--flow', 'observe']),
                    ('observe', [cli, 'run', project, '--flow', 'observe', '--allow-effects', '--trace-out', trace])]
        for label, argv in commands:
            command = dict(label=label, command=list(map(str, argv)))
            result['commands'].append(command)
            save()
            observed = subprocess.run(command['command'], capture_output=True, timeout=180)
            (evidence / (label + '.stdout.bin')).write_bytes(observed.stdout)
            (evidence / (label + '.stderr.bin')).write_bytes(observed.stderr)
            command.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode())
            save()
            assert observed.returncode == 0 and not observed.stderr, command
            if label == 'check':
                assert command['stdout'] == 'checked ' + str(len(MODULES) + 1) + ' files\n', command
            elif label.endswith('effects'):
                effect_contract(command['stdout'], [] if label == 'pure-effects' else ['Console.stdout_write'])
            else:
                assert command['stdout'] == ''.join('PASS ' + name + '\n' for name, _ in checks), command
                report = json.loads(trace.read_text())
                assert report['schema'] == 'etas.cli.interpreter-report.v1', report
                assert not report.get('incomplete', False) and report['termination']['local_work_settled'] is True, report
                actions = [event['qualified_action'] for event in report['events'] if event['kind'] == 'host_request_started']
                assert set(actions) <= {'Policy.evaluate', 'Console.stdout_write'}, actions
                assert actions.count('Console.stdout_write') == len(checks), actions
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', failure=repr(error))
        raise
    finally:
        result['resources'], valid = resources()
        if not valid:
            result.update(status='failed', resource_failure='ordinary resource guard failed')
        save()
        assert valid, result
    print('PASS ' + str(len(checks)) + ' grouped closed Context/string checks', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    options = parser.parse_args()
    options.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='context-selection-pure-', dir=options.evidence_dir)).resolve()
    print('EVIDENCE ' + str(evidence), flush=True)
    pure(evidence, options.prepare_only)


if __name__ == '__main__':
    main()
