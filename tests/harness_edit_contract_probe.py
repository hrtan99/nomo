#!/usr/bin/env python3
"""Pure bounded model-edit protocol, context, ledger and argument checks."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from edit_contract_probe import literal, record
from harness_checkpoint_contract_probe import MANIFEST
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/harness_edit001/contract_probe.es'
MODULES = ['core/text.es', 'tools/path_policy.es', 'tools/edit_proposal.es', 'tools/edit_encoding.es',
           'session/edit_operation.es', 'harness/harness_edit_contract.es', 'cli/harness_edit_args.es']
wire = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'))
sha = lambda value: hashlib.sha256(value.encode()).hexdigest()


def cases():
    checks = []
    def add(label, expressions): checks.append((label, ' && '.join(expressions)))
    def child(raw, target='', replacement='', denied=True):
        return 'child('+literal(raw)+', '+literal(target)+', '+literal(replacement)+', '+literal(denied)+')'
    def plan(raw, expected='', denied=True): return 'plan('+literal(raw)+', '+literal(expected)+', '+literal(denied)+')'
    task = '😀'*128
    add('plan_complete_unicode_and_control', [plan(wire(['delegate', task]), task, False), plan(wire(['delegate', '前\n任务']), '前\n任务', False)])
    add('plan_shape_and_verb_refused', [plan(raw) for raw in ['["delegate"]', '["delegate","x","y"]', '["delegate",["x"]]', '["delegate",1]', '["other","x"]']])
    add('plan_decoded_bytes_nul_blank_refused', [plan(wire(['delegate', value])) for value in [task+'x', '\x00', ' \n']])
    raw_plan = wire(['delegate', 'x']); padded_plan = ' '*(4096-len(raw_plan))+raw_plan
    add('plan_raw_utf8_byte_boundary', [plan(padded_plan, 'x', False), plan(' '+padded_plan), plan(wire(['delegate', 'é'*2048]))])
    add('child_literals_unicode_and_deletion', [child(wire(['edit', '前😀"\\\n', '新\t']), '前😀"\\\n', '新\t', False), child('["edit","x",""]', 'x', '', False)])
    add('child_shape_and_binding_fields_refused', [child(raw) for raw in ['["edit","x"]', '["edit","x","y","path"]', '["edit",["x"],"y"]', '["edit",{},"y"]', '["edit",1,"y"]', '["replace","x","y"]']])
    add('child_malformed_json_and_prose_refused', [child(raw) for raw in ['```["edit","x","y"]```', '["edit","x" "y"]', '["edit","x","\\q"]', '["edit","x","y",]']])
    add('child_nul_and_empty_target_refused', [child(wire(['edit', target, replacement])) for target, replacement in [('', 'x'), ('\x00', 'y'), ('x', '\x00')]])
    field = '😀'*512
    add('child_decoded_unicode_2048_2049_bytes', [child(wire(['edit', field, field]), field, field, False), child(wire(['edit', field+'x', 'y'])), child(wire(['edit', 'x', field+'y']))])
    raw_child = '["edit","x",""]'; padded_child = ' '*(32768-len(raw_child))+raw_child
    add('child_raw_utf8_byte_boundary', [child(padded_child, 'x', '', False), child(' '+padded_child), child(wire(['edit', 'x', 'é'*16384]))])
    before, after = '\x01'*2048, '\x02'*2048
    context = dict(phase='plan', request='修改这个文件', task='', id='op', workspace='owned', path='note.txt', before=before,
                   after='', request_digest='', before_digest='', after_digest='', before_bytes=2048, after_bytes=0, completed=False)
    ctx = lambda **changes: record('Context', dict(context, **changes))
    add('plan_full_2048_byte_original_roundtrip', ['roundtrip('+ctx()+')'])
    add('child_full_unicode_original_task_request', ['roundtrip('+ctx(phase='child', before=field, request=task, task=task)+')'])
    completed = dict(context, phase='aggregate', task=task, after=after, request_digest='a'*64,
                     before_digest=sha(before), after_digest=sha(after), after_bytes=2048, completed=True)
    done = lambda **changes: record('Context', dict(completed, **changes))
    assert len(wire(completed).encode()) <= 65536
    add('completed_full_2048_byte_before_after_roundtrip', ['roundtrip('+done()+')', 'roundtrip('+done(after='', after_bytes=0, after_digest=sha(''))+')'])
    add('context_phase_and_completion_refused', ['contextual('+value+', false)' for value in [ctx(phase='other'), ctx(completed=True), ctx(after='x'), done(completed=False)]])
    add('context_digest_binding_refused', ['contextual('+value+', false)' for value in [done(request_digest='bad'), done(before_digest='b'*64), done(after_digest=sha(before))]])
    add('context_byte_counts_and_nul_refused', ['contextual('+value+', false)' for value in [ctx(before_bytes=2047), ctx(before=field+'x', before_bytes=2049), ctx(before='x\x00', before_bytes=2), done(after_bytes=2047), done(after='x\x00', after_bytes=2)]])
    add('ledger_exact_stages_and_reserved_aggregate', ['normal_ledger()'])
    def ledger(**changes):
        value = dict(steps=0, calls=0, tokens=0, native_tokens=0, boundaries=0); value.update(changes)
        if 'native_tokens' not in changes: value['native_tokens'] = [0, 32768, 98304, 163840][value['calls']]
        return record('Ledger', value)
    add('ledger_out_of_order_and_fourth_call_blocked', ['blocked('+value+', '+literal(call)+')' for value, call in [(ledger(), False), (ledger(steps=1, calls=1, tokens=4096), True), (ledger(steps=4, calls=2, tokens=36864, boundaries=2), True), (ledger(steps=6, calls=3, tokens=38912, boundaries=3), True)]])
    add('ledger_invalid_state_and_overspend_refused', ['ledger_error('+value+') != ""' for value in [ledger(steps=-1), ledger(steps=7, calls=3, tokens=38912, boundaries=4), ledger(steps=1, calls=1, tokens=32768), ledger(steps=4, calls=3, tokens=38912, boundaries=1), ledger(native_tokens=-1), ledger(native_tokens=163841), ledger(steps=1, calls=1, tokens=4096, native_tokens=32767)]])
    args = ['--id', 'op', '--workspace', 'owned', '--path', 'note.txt', '--once', task]
    expected = dict(help=False, id='op', workspace='owned', path='note.txt', request=task)
    def arguments(values, denied=False, changed=None): return 'arguments('+literal(values)+', '+record('Input', changed or expected)+', '+literal(denied)+')'
    add('cli_reordered_unicode_and_control_preserved', [arguments(args), arguments(args[6:]+args[:6]), arguments(args[:7]+['前\n任务'], changed=dict(expected, request='前\n任务'))])
    add('cli_help_duplicate_unknown_arity', [arguments(['--help'], changed=dict(help=True, id='', workspace='', path='', request='')), arguments(args[:6]+['--id', 'other'], True), arguments(args[:6]+['--other', 'x'], True), arguments(args[:-1], True)])
    bad_args = [args[:7]+[value] for value in ['', ' \n', task+'x', 'x\x00']]+[args[:5]+['../outside']+args[6:], ['--id', '\x1b']+args[2:]]
    add('cli_task_bytes_nul_blank_and_selectors_refused', [arguments(value, True) for value in bad_args])
    assert len(checks) == 22
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true'); args = parser.parse_args(); checks = cases()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='harness-edit-contract-', dir=args.evidence_dir)); project = evidence/'project'
    (project/'src/app').mkdir(parents=True)
    for name in MODULES:
        target = project/'src/nomo'/name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT/'src/nomo'/name, target)
    expressions = ['Check { label = '+literal(label)+', passed = '+expression+' }' for label, expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__', '['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe', 'harness-edit-contract-probe'))
    result = dict(task='HARNESS-EDIT-001A-pure', status='prepared', checks=[label for label, _ in checks], commands=[])
    output = evidence/'results.json'; save = lambda: output.write_text(json.dumps(result, indent=2)+'\n')
    save(); print('EVIDENCE '+str(evidence), flush=True)
    if args.prepare_only: return
    try:
        cli = verify_cli()
        for label, argv, expected in [('check', [cli, 'check', '--all', project], 'checked 8 files\n'),
            ('effects', [cli, 'effects', project, '--flow', 'pure_probe'], None),
            ('observe', [cli, 'run', project, '--flow', 'observe', '--allow-effects'], ''.join('PASS '+label+'\n' for label, _ in checks))]:
            item = dict(label=label, command=list(map(str, argv))); result['commands'].append(item); save()
            observed = subprocess.run(item['command'], capture_output=True, timeout=180)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout); (evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode()); save()
            assert observed.returncode == 0 and not observed.stderr, item
            if expected is not None: assert item['stdout'] == expected, item
            else: assert item['stdout'].count('requested actions: []') == item['stdout'].count('default actions: []') == 1, item
        result['status'] = 'passed'
    except BaseException as error: result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'] = {name: (Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max', 'memory.peak', 'memory.events', 'cpu.max', 'pids.max']}
        resource = result['resources']; events = dict(line.split() for line in resource['memory.events'].splitlines())
        valid = resource['memory.max'] == '4294967296' and resource['cpu.max'] == '400000 100000' and resource['pids.max'] == '256' and all(events[key] == '0' for key in ['max', 'oom', 'oom_kill', 'oom_group_kill'])
        if not valid: result.update(status='failed', resource_failure='ordinary resource guard failed')
        save(); assert valid, result
    print('PASS 22 grouped pure harness edit checks', flush=True)


if __name__ == '__main__': main()
