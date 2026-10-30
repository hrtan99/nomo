#!/usr/bin/env python3
"""Focused ARCH-CONTRACTS-001 pure ownership and compatibility controls.

Source candidate only; author has not imported or executed this driver.
Root runs on selected official009, one ordinary serial lane. No Model, application
Fs/Memory/Approval/Command or storage lifecycle is part of these three packages.
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

from edit_contract_probe import literal, record
from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import resources
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'tests/fixtures/arch_edit_contract001'
COMPONENTS = {'leaf': {'fixture': 'leaf_probe.es', 'modules': ['core/text.es', 'session/edit_operation.es', 'tools/edit_contract.es', 'tools/edit_proposal.es', 'tools/path_policy.es']}, 'consumers': {'fixture': 'consumer_probe.es', 'modules': ['core/conversation.es', 'core/text.es', 'entry/edit_context.es', 'harness/edit_context.es', 'harness/harness_edit_contract.es', 'harness/harness_model_contract.es', 'harness/harness_tool_contract.es', 'harness/harness_work_contract.es', 'harness/model_plan_diagnostic.es', 'model/model_tool_contract.es', 'model/tool_context.es', 'session/edit_operation.es', 'session/work_record.es', 'tools/edit_binding.es', 'tools/edit_contract.es', 'tools/edit_encoding.es', 'tools/edit_proposal.es', 'tools/path_policy.es']}, 'compat': {'fixture': 'compat_probe.es', 'modules': ['core/text.es', 'entry/edit_coordinator.es', 'session/edit_operation.es', 'session/edit_operation_store.es', 'tools/edit_binding.es', 'tools/edit_contract.es', 'tools/edit_encoding.es', 'tools/edit_file.es', 'tools/edit_proposal.es', 'tools/path_policy.es', 'ui/edit_diff.es', 'harness/edit_original.es']}}

REGION = 'nomo.tools.edit_file.EditableRoot'
sha = lambda value: hashlib.sha256(value.encode()).hexdigest()
READ = dict(steps=7, calls=4, tokens=8192, tools=1, scan=4096)
BASE = dict(request='update target using context', task='read context.txt', operation='read', files=['context.txt'], literal='',
            outcome='complete: blue<LF>', result='The context selects blue.', summary='Use blue from context.txt.', allowed=['context.txt'])

def ascii_json(value):
    def quote(text):
        out = '"'
        for char in text:
            code = ord(char)
            if char in ['"','\\']: out += '\\'+char
            elif 32 <= code <= 126: out += char
            elif code <= 65535: out += '\\u'+format(code,'04x')
            else:
                code -= 65536
                out += '\\u'+format(55296+(code>>10),'04x')+'\\u'+format(56320+(code&1023),'04x')
        return out+'"'
    if isinstance(value,dict): return '{'+','.join(quote(k)+':'+quote(v) for k,v in value.items())+'}'
    return '['+','.join(quote(v) for v in value)+']'

def projection(*, before='old\n', target='old', replacement='blue', task='replace selected with blue', summary='Applied blue.',
               evidence=None, id='op', workspace='owned', path='target.txt'):
    evidence = deepcopy(BASE if evidence is None else evidence)
    assert before.count(target) == 1
    after = before.replace(target, replacement)
    canonical = ascii_json(['nomo-edit-request-v1', id, workspace, REGION, path, before, target, replacement, after])
    binding = dict(id=id, workspace=workspace, region=REGION, path=path, request_digest=sha(canonical),
                   before_digest=sha(before), after_digest=sha(after), before_bytes=len(before.encode()), after_bytes=len(after.encode()))
    fields = ['nomo-work-record-v1', 'summary-unconfirmed', id, workspace, REGION, path,
              binding['request_digest'], binding['before_digest'], binding['after_digest'], str(binding['before_bytes']), str(binding['after_bytes']),
              evidence['request'], evidence['task'], evidence['operation'], evidence['allowed'][0], evidence['allowed'][1] if len(evidence['allowed']) == 2 else '',
              evidence['files'][0], evidence['files'][1] if len(evidence['files']) == 2 else '', evidence['literal'], evidence['outcome'], evidence['result'], evidence['summary'],
              task, target, replacement, before, after, '', '7', '4', '8192', '1', '4096', '5', '2', '36864', '98304', '3',
              '13', '7', '47104', '196608', '1', '4096', '3', '6144', '1', '2048', '1', '1', '2048', '65536']
    complete = list(fields); complete[1] = 'summary-confirmed'; complete[27] = summary
    complete[33:38] = ['6', '3', '38912', '163840', '3']; complete[48:] = ['0']*4
    assert len(fields) == len(complete) == 52
    return dict(binding=binding, evidence=evidence, task=task, before=before, after=after, target=target, replacement=replacement,
                summary=summary, fields=fields, complete=complete)

def leaf_cases():
    def built(before, target, replacement, after):
        return 'prepared(' + ', '.join(map(literal, ['note.txt', before, target, replacement, after])) + ')'
    def refused(before, target, replacement, error, path='note.txt'):
        return 'refused(' + ', '.join(map(literal, [path, before, target, replacement, error])) + ')'
    exact = '雪' * 682 + 'ab'
    return [
        ('complete_prepared_request_and_proposal', built('old\n', 'old', 'new', 'new\n')),
        ('literal_unicode_crlf_and_empty_replacement', built('前😀\r\n', '前', '新', '新😀\r\n') + ' && ' + built('old', 'old', '', '')),
        ('exact_2048_utf8_original_boundary', built(exact, exact, 'new', 'new')),
        ('original_and_replacement_utf8_overflow_refused', refused(exact + 'x', exact, 'new', 'original exceeds 2048 UTF-8 bytes') + ' && ' + refused('old', 'old', exact + 'x', 'replacement exceeds 2048 UTF-8 bytes')),
        ('literal_ambiguity_missing_and_noop_refused', refused('aaa', 'aa', 'b', 'literal target is ambiguous') + ' && ' + refused('old', 'absent', 'new', 'literal target not found') + ' && ' + refused('old', 'old', 'old', 'replacement leaves original unchanged')),
        ('invalid_path_and_empty_target_refused', refused('old', 'old', 'new', 'invalid relative path', '../outside') + ' && ' + refused('old', '', 'new', 'target must not be empty')),
    ]


def consumer_cases():
    def binding(value): return record('Binding', value)
    def evidence(value): return record('Evidence', value)[:-2] + ', ledger = ' + record('ReadLedger', READ) + ' }'
    def roundtrip(value):
        return 'roundtrip(' + ', '.join([binding(value['binding']), evidence(value['evidence']),
            *[literal(value[key]) for key in ['task', 'before', 'after', 'target', 'replacement', 'summary', 'fields', 'complete']]]) + ')'
    value = projection(before='前😀\r\n', target='前', replacement='新')
    selected = value['binding']
    selector = dict(id=selected['id'], workspace=selected['workspace'], path=selected['path'])
    initial = dict(phase='child', request='request', task='task', id=selected['id'], workspace=selected['workspace'], path=selected['path'],
                   before=value['before'], after='', request_digest='', before_digest='', after_digest='',
                   before_bytes=len(value['before'].encode()), after_bytes=0, completed=False)
    completed = dict(initial, phase='aggregate', after=value['after'], request_digest=selected['request_digest'],
                     before_digest=selected['before_digest'], after_digest=selected['after_digest'],
                     before_bytes=selected['before_bytes'], after_bytes=selected['after_bytes'], completed=True)
    projected = 'projected(' + ', '.join([record('Selector', selector), binding(selected), literal(value['before']),
                                         literal(value['after']), record('Context', initial), record('Context', completed)]) + ')'
    empty_binding = dict(selected, before_bytes=0, after_bytes=0)
    empty_initial = dict(initial, before='', after='', before_bytes=0, after_bytes=0)
    empty_completed = dict(empty_initial, phase='aggregate', request_digest=empty_binding['request_digest'],
                           before_digest=empty_binding['before_digest'], after_digest=empty_binding['after_digest'], completed=True)
    empty_projected = 'projected(' + ', '.join([record('Selector', selector), binding(empty_binding), literal(''), literal(''),
                                               record('Context', empty_initial), record('Context', empty_completed)]) + ')'
    return [('ascii_work_record_and_exact_binding_roundtrip', roundtrip(projection())),
            ('unicode_crlf_work_record_and_region_digest_roundtrip', roundtrip(value)),
            ('forged_prepared_value_refused_by_binding', 'binding_refused("proposal differs from validated replacement")'),
            ('whole_initial_and_confirmed_context_projection', projected),
            ('empty_initial_and_confirmed_context_projection', empty_projected)]


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def hashes(project):
    return {str(path.relative_to(project)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(project.rglob('*')) if path.is_file()}


def environment():
    names = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CARGO_HOME', 'CARGO_TARGET_DIR']
    return {name: os.environ[name] for name in names if name in os.environ} | dict(
        NOMO_NORMAL_GRAPH='latest', ETAS_HOST_FILESYSTEM='none', ETAS_HOST_MEMORY='none',
        ETAS_HOST_SESSION='none', ETAS_HOST_APPROVAL='deny')


def trace(path):
    value = json.loads(path.read_text())
    assert value['schema'] == 'etas.cli.interpreter-report.v1' and not value.get('incomplete', False)
    assert value['outcome']['kind'] == 'completed' and value['termination']['local_work_settled'] is True
    starts = [item for item in value['events'] if item['kind'] == 'host_request_started']
    ends = [item for item in value['events'] if item['kind'] == 'host_request_finished']
    ids = [item['id'] for item in starts]; finished = [item['id'] for item in ends]
    assert len(ids) == len(set(ids)) and len(finished) == len(set(finished))
    assert len(ids) == len(finished) and set(ids) == set(finished)
    assert all(item['outcome']['kind'] == 'succeeded' for item in ends)
    assert all(item['qualified_action'] in ['Console.stdout_write', 'Policy.evaluate'] for item in starts)
    return dict(complete=True, application_Model_Fs_Memory_Approval_Command=0, paired_host_requests=len(starts))


def component(parent, name, prepare_only):
    definition = COMPONENTS[name]
    folder = Path(tempfile.mkdtemp(prefix='arch-edit-' + name + '-', dir=parent))
    project = folder / 'project'; (project / 'src/app').mkdir(parents=True)
    assert name == 'compat' or not {'tools/edit_file.es', 'entry/edit_coordinator.es'}.intersection(definition['modules'])
    for relative in definition['modules']:
        target = project / 'src/nomo' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'src/nomo' / relative, target)
    checks = leaf_cases() if name == 'leaf' else consumer_cases() if name == 'consumers' else [('facade_reexports_preserve_nominal_identity', '')]
    source = (FIXTURES / definition['fixture']).read_text()
    if name != 'compat':
        expressions = ['Check { label = ' + literal(label) + ', passed = ' + expression + ' }' for label, expression in checks]
        source = source.replace('__CHECKS__', '[' + ',\n'.join(expressions) + ']')
    assert '__CHECKS__' not in source
    (project / 'src/app/contract_probe.es').write_text(source)
    policy = '["console=allow", "model=deny", "filesystem=deny", "memory=deny", "session=deny", "approval=deny", "command=deny"]'
    (project / 'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe', 'arch-edit-contract-probe').replace('["console=allow"]', policy))
    expected = hashes(project)
    result = dict(task='ARCH-CONTRACTS-001', component=name, status='prepared', inputs=expected,
                  driver_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), checks=[label for label, _ in checks], commands=[],
                  qualification='Pure builder/binding/record/context/nominal-compatibility only. No actual application Model/Fs/Memory/Approval/Command; Console observation is separately traced.')
    output = folder / 'results.json'; save(output, result)
    print('EVIDENCE ' + str(folder), flush=True)
    if prepare_only: return
    error = None
    try:
        cli = verify_cli()
        commands = [('check', [cli, 'check', '--all', project]),
                    ('pure-effects', [cli, 'effects', project, '--flow', 'pure_probe']),
                    ('observe-effects', [cli, 'effects', project, '--flow', 'observe']),
                    ('observe', [cli, 'run', project, '--flow', 'observe', '--allow-effects', '--budget-time', '30s', '--trace-out', folder / 'observe.trace.json'])]
        for label, argv in commands:
            assert hashes(project) == expected
            item = dict(label=label, command=list(map(str, argv))); result['commands'].append(item); save(output, result)
            observed = subprocess.run(item['command'], capture_output=True, timeout=45, input=b'', env=environment())
            (folder / (label + '.stdout.bin')).write_bytes(observed.stdout)
            (folder / (label + '.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode()); save(output, result)
            assert observed.returncode == 0 and not observed.stderr, item
            if label == 'check': assert item['stdout'] == 'checked ' + str(len(definition['modules']) + 1) + ' files\n', item
            elif label.endswith('effects'):
                assert 'rejected' not in item['stdout'].lower() and 'Unresolved' not in item['stdout'], item
                for row in ['requested actions', 'default actions']:
                    actual = re.findall(r'^\s*' + row + ': (.+)$', item['stdout'], re.M)
                    assert actual == (['[]'] if label == 'pure-effects' else ['[Console.stdout_write]']), item
                support = re.findall(r'^\s*support: (.+)$', item['stdout'], re.M)
                assert support == (['local'] if label == 'pure-effects' else ['requires-host[Console]']), item
            else:
                assert item['stdout'] == ''.join('PASS ' + label + '\n' for label, _ in checks), item
                result['trace'] = trace(folder / 'observe.trace.json')
        assert hashes(project) == expected
        result['status'] = 'passed'
    except BaseException as failure:
        error = failure; result.update(status='failed', failure=repr(failure))
    finally:
        try:
            result['resources'], valid = resources()
            if not valid: result.update(status='failed', resource_failure=True)
        except BaseException as failure:
            valid = False; result.update(status='failed', resources=None, resource_failure=repr(failure), observer_outcome='unknown')
            error = error or failure
        try: save(output, result)
        except BaseException as failure: error = error or failure
    if error is not None: raise error
    assert valid, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--component', choices=['all', 'leaf', 'consumers', 'compat'], default='all')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args(); args.evidence_dir.mkdir(parents=True, exist_ok=True)
    for name in COMPONENTS if args.component == 'all' else [args.component]:
        component(args.evidence_dir, name, args.prepare_only)


if __name__ == '__main__':
    main()
