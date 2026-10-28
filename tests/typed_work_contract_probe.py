#!/usr/bin/env python3
"""Focused pure typed-work projection/reservation checks; never invokes an Agent."""
import argparse
import hashlib
import json
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
FIXTURE = ROOT/'tests/fixtures/typed_work001/contract_probe.es'
SEEDS = ['nomo.harness.typed_work_contract', 'nomo.harness.typed_work_reservation']


def cases():
    checks = []
    def add(label, *expressions): checks.append((label, ' && '.join(expressions)))
    def call(name, *args): return name+'('+', '.join(literal(value) for value in args)+')'
    def action(operation='read', files=None, text='', allowed=None, final=False, error=''):
        return call('read_action', operation, ['context.txt'] if files is None else files, text,
                    ['context.txt'] if allowed is None else allowed, final, error)
    add('read_plan127_128_129', *(call('read_plan', 't'*size, 'plan', size <= 128) for size in [127, 128, 129]))
    add('read_plan_blank_control_unicode_and_wrong_phase', *(call('read_plan', text, phase, False)
        for text, phase in [('', 'plan'), ('  ', 'plan'), ('x\n', 'plan'), ('雪', 'plan'), ('Read context', 'aggregate')]))
    add('read_one_and_search_two_files', action(), action('search', ['other.txt', 'context.txt'], 'NEEDLE', ['context.txt', 'other.txt']))
    add('search_whitespace_is_literal_data', action('search', text=' '))
    add('read_nonempty_literal_is_refused', action(text='unexpected', error='read action requires an empty literal'))
    add('read_arity_and_stage_refused', action(files=[], error='unsupported action or arity'),
        action(files=['context.txt', 'other.txt'], error='unsupported action or arity'),
        action(final=True, error='typed child context phase mismatch'))
    add('unsupported_actions_refused', *(action(operation=operation, error='unsupported action or arity') for operation in ['final', 'write', 'READ']))
    add('search_literal_bounds_and_controls', *(action('search', text=text, error='invalid search literal') for text in ['', 'x'*65, 'x\n', '雪']))
    add('selected_paths_authority_and_uniqueness', action(files=['../outside'], error='invalid allowed file'),
        action(files=['outside.txt'], error='selected file is not allowed'),
        action('search', ['context.txt', 'context.txt'], 'x', error='duplicate allowed file'),
        action(allowed=[], error='expected one or two allowed files'))
    add('legacy_read_and_search_wire_unchanged',
        call('legacy', '["read","context.txt"]', ['context.txt'], 'read', ''),
        call('legacy', '["search"," ","context.txt"]', ['context.txt'], 'search', ''),
        call('legacy', '["read","context.txt","extra"]', ['context.txt'], '', 'unsupported action or arity'))
    add('legacy_error_precedence_and_text_unchanged',
        call('legacy', '["search","","../outside"]', ['context.txt'], '', 'invalid search literal'),
        call('legacy', '["read","outside.txt"]', ['context.txt'], '', 'selected file is not allowed'),
        call('legacy', '["search","x","context.txt","context.txt"]', ['context.txt'], '', 'duplicate allowed file'))
    add('read_final256_257', call('read_final', 'x'*256, True, True), call('read_final', 'x'*257, True, False))
    add('read_final_blank_control_unicode_or_wrong_stage_refused',
        *(call('read_final', text, True, False) for text in ['', ' ', 'x\n', '雪']), call('read_final', 'Observed text', False, False))
    add('read_aggregate512_513_and_jsonlooking_data', call('read_summary', 'x'*512, 'aggregate', True),
        call('read_summary', 'x'*513, 'aggregate', False), call('read_summary', '{"data":"literal"}', 'aggregate', True))
    add('read_aggregate_blank_controls_unicode_or_wrong_phase_refused',
        *(call('read_summary', text, 'aggregate', False) for text in ['', ' ', 'x\n', '雪']), call('read_summary', 'Observed text', 'plan', False))

    base = dict(request='Change chosen using observed context', task='Read context.txt', operation='read', files=['context.txt'], literal='',
                outcome='complete: supporting text', result='Observed supporting text.', summary='Use actual supporting text.', allowed=['context.txt'])
    complete = dict(steps=7, calls=4, tokens=8192, tools=1, scan=4096)
    pending = dict(steps=5, calls=3, tokens=6144, tools=1, scan=4096)
    def evidence(ledger, **changes):
        return record('Evidence', dict(base, **changes))[:-2]+', ledger = '+record('ReadLedger', ledger)+' }'
    settled = evidence(complete)
    def finish(ledger=pending, summary=base['summary'], denied=False, **changes):
        selected = dict(summary='', **changes)
        return 'settled('+evidence(ledger, **selected)+', '+literal(summary)+', '+settled+', '+literal(denied)+')'
    add('settlement_preserves_actual_tool_outcome_selection_result_and_ledger', finish())
    add('typed_answer_cannot_create_success_or_refund_ledger',
        finish(denied=True, outcome='failed: not complete'), finish(denied=True, operation='final'),
        finish(ledger=dict(pending, tools=0, scan=0), denied=True),
        finish(ledger=complete, denied=True), finish(denied=True, summary=' '),
        finish(denied=True, result='x'*257))
    add('edit_plan512_UTF8_and513', call('edit_plan', 'é'*256, 'plan', False, True),
        call('edit_plan', 'é'*256+'x', 'plan', False, False))
    add('edit_plan_blank_NUL_phase_and_request_binding_refused',
        *(call('edit_plan', text, phase, changed, False) for text, phase, changed in
          [('', 'plan', False), (' ', 'plan', False), ('x\0', 'plan', False), ('Change chosen', 'child', False), ('Change chosen', 'plan', True)]))
    add('all_three_edit_contexts_preserve_relevant_parent_facts', *(call('parents_preserved', phase) for phase in ['plan', 'child', 'aggregate']))
    add('edit_child_binds_current_path_and_original', call('edit_child', 'head chosen tail', 'chosen', 'updated', 'child', False, 'head updated tail', True))
    add('edit_child_empty_replacement_and_line_endings_are_literal',
        call('edit_child', 'head\r\nchosen\r\ntail', 'chosen', '', 'child', False, 'head\r\n\r\ntail', True),
        call('edit_child', 'chosen\n', 'chosen\\n', 'updated', 'child', False, '', False))
    add('edit_child_existing_ambiguity_and_unchanged_guards',
        call('edit_child', 'aaa', 'aa', 'updated', 'child', False, '', False),
        call('edit_child', 'chosen', 'chosen', 'chosen', 'child', False, '', False))
    add('edit_child_full_context_phase_and_request_binding_refused',
        call('edit_child', 'chosen', 'chosen', 'updated', 'plan', False, '', False),
        call('edit_child', 'chosen', 'chosen', 'updated', 'child', True, '', False))
    add('edit_child_result_UTF8_limit_refused', call('edit_child', 'ax', 'x', 'é'*1024, 'child', False, '', False))
    add('edit_aggregate512_UTF8_and513', call('edit_summary', 'é'*256, True, False, True),
        call('edit_summary', 'é'*256+'x', True, False, False))
    add('edit_answer_requires_confirmed_current_context', call('edit_summary', 'Changed selected text', False, False, False),
        call('edit_summary', 'Changed selected text', True, True, False),
        call('edit_summary', 'x\0', True, False, False))

    policy = dict(repair_rounds=8, http_attempts=1)
    maximum = dict(logical=7, native_requests=63, http_attempts=189, generation=423936)
    envelope = lambda **changes: record('Envelope', dict(maximum, **changes))
    def admission(policy_changes=None, **changes):
        return 'admission('+record('Policy', dict(policy, **(policy_changes or {})))+', '+envelope(**changes)+', false)'
    add('repair_aware_full_envelopes_A1_A2_A3', *( 'admission('+record('Policy', dict(policy, http_attempts=attempts))+', '+envelope()+', true)' for attempts in [1, 2, 3]))
    add('old_v2_and_each_insufficient_dimension_refused',
        admission(native_requests=7, http_attempts=7, generation=47104), admission(logical=6),
        admission(native_requests=62), admission(http_attempts=62), admission(generation=423935),
        admission(dict(http_attempts=3), http_attempts=188))
    add('unsupported_policy_refused_before_arithmetic', *(admission(change) for change in
        [dict(repair_rounds=0), dict(repair_rounds=7), dict(repair_rounds=9), dict(repair_rounds=2147483647),
         dict(http_attempts=0), dict(http_attempts=4), dict(http_attempts=-1), dict(http_attempts=2147483647)]))
    add('negative_or_extreme_maxima_refused', *(admission(**{field:value}) for field in maximum for value in [-1, 2147483647]))
    full = dict(logical=7, native_requests=63, http_attempts=63, generation=423936)
    zero = dict(logical=0, native_requests=0, http_attempts=0, generation=0)
    def state(stages=0, reserve=None, attempted=None, policy_change=None):
        return 'Reservation { assumptions = '+record('Policy', dict(policy, **(policy_change or {})))+', maximum = '+envelope()+', reserved = '+record('Envelope', full if reserve is None else reserve)+', attempted = '+record('Envelope', zero if attempted is None else attempted)+', stages = '+str(stages)+', stopped = false }'
    add('reservation_stage_and_policy_overflow_refused', *( 'rejected('+value+')' for value in
        [state(-1), state(2147483647), state(policy_change=dict(repair_rounds=2147483647)), state(policy_change=dict(http_attempts=2147483647))]))
    add('forged_reserved_and_attempted_envelopes_refused', *( 'rejected('+value+')' for value in
        [state(reserve=dict(full, generation=47104)), state(reserve=zero), state(attempted=dict(zero, native_requests=1)),
         state(attempted=dict(zero, generation=2147483647)), state(1), state(attempted=dict(zero, http_attempts=-1))]))
    add('precharge_all7_stages_then_refuse8th_A1_A3', 'progression(1)', 'progression(3)')
    add('stop_no_refund_before_attempt_or_after_any_stage', 'stopped_without_attempt()')
    assert 0 < len(checks) <= 64 and len(checks) == len({label for label, _ in checks})
    return checks


def source_closure():
    pending, found = list(SEEDS), {}
    while pending:
        module = pending.pop()
        if module in found: continue
        path = (ROOT/'src').joinpath(*module.split('.')).with_suffix('.es')
        body = path.read_text()
        assert re.findall(r'^\s*module\s+([\w.]+)\s*;', body, re.M) == [module], path
        found[module] = path
        for imported in re.findall(r'^\s*import\s+(nomo(?:\.[A-Za-z_]\w*)*)[.\s;]', body, re.M):
            parts = imported.split('.')
            selected = ['.'.join(parts[:end]) for end in range(2, len(parts)+1)
                        if (ROOT/'src').joinpath(*parts[:end]).with_suffix('.es').is_file()]
            assert len(selected) == 1, imported
            pending.append(selected[0])
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    options = parser.parse_args()
    checks = cases(); options.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='typed-work001-', dir=options.evidence_dir)).resolve()
    project = evidence/'project'; (project/'src/app').mkdir(parents=True)
    sources = {}
    for module, source in sorted(source_closure().items()):
        relative = source.relative_to(ROOT); target = project/relative
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, target)
        sources[str(relative)] = hashlib.sha256(source.read_bytes()).hexdigest()
    expressions = ['Check { label = '+literal(label)+', passed = '+expression+' }' for label, expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__', '['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe', 'typed-work001-contract-probe'))
    for path in (ROOT/'src').rglob('*.es'):
        if path.stem in ('typed_work_contract', 'typed_work_reservation'): continue
        body = path.read_text()
        assert all(module not in body for module in SEEDS), path
    result = dict(task='TYPED-WORK-001', status='prepared', checks=[label for label, _ in checks], sources=sources, commands=[],
                  scope='Four record shapes, seven pure projectors, actual-outcome settlement and independent reservation only. Seven new typed Agent callers remain held for backend qualification.',
                  actual_actions=dict(Model=0, provider=0, File=0, Memory=0, Approval=0, v2_admission=0, durable_lifetime=0),
                  pure_effects='Must be empty even though unchanged legacy Agent declarations are in the transitive source closure.',
                  reservation='Fixed audited repair ceiling8; HTTP attempt envelopes1..3 are application policy assumptions, not native settings. Holds full 7/63/(63*A)/423936 from admission, precharges stages and never refunds stopped/uncertain attempts.',
                  limitations='No backend/repair/usage/accounting execution, default/v2/UI integration, current File observation, approval, receipt or persistence proof.',
                  default_v2_imports_new_route=False)
    output = evidence/'results.json'
    def save(): output.write_text(json.dumps(result, indent=2)+'\n')
    save(); print('EVIDENCE '+str(evidence), flush=True)
    if options.prepare_only: return 0
    try:
        cli = verify_cli(); count = len(list((project/'src').rglob('*.es')))
        commands = [('check', [cli, 'check', '--all', project], 'checked '+str(count)+' files\n'),
                    ('pure-effects', [cli, 'effects', project, '--flow', 'pure_probe'], None),
                    ('observe-effects', [cli, 'effects', project, '--flow', 'observe'], None),
                    ('observe', [cli, 'run', project, '--flow', 'observe', '--allow-effects'],
                     ''.join('PASS '+label+'\n' for label, _ in checks))]
        for label, argv, expected in commands:
            item = dict(label=label, command=list(map(str, argv))); result['commands'].append(item); save()
            observed = subprocess.run(item['command'], capture_output=True, timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout); (evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode()); save()
            failure_context = (label, observed.returncode, str(evidence))
            assert observed.returncode == 0 and not observed.stderr, failure_context
            if expected is not None: assert item['stdout'] == expected, failure_context
            elif label == 'pure-effects':
                assert item['stdout'].count('requested actions: []') == item['stdout'].count('default actions: []') == 1, failure_context
            else:
                assert 'Console.stdout_write' in item['stdout'] and not any(name in item['stdout'] for name in ('Agentic.', 'Fs.', 'Memory.', 'Approval.', 'Console.stdin')), failure_context
        result['status'] = 'pure-partial-passed'
    except BaseException as error:
        result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'], valid = resources()
        if not valid: result.update(status='failed', resource_failure='ordinary4GiB resource guard software bug')
        save(); assert valid, result
    print('PASS '+str(len(checks))+' grouped pure typed-work checks; seven Agent callers held; zero Model/admission', flush=True)
    return 0


if __name__ == '__main__': raise SystemExit(main())
