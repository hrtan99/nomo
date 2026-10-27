#!/usr/bin/env python3
"""Pure read-evidence, edit-context, shared-budget and work-argument checks."""
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
FIXTURE = ROOT/'tests/fixtures/harness_work001/contract_probe.es'
MODULES = ['core/text.es', 'core/conversation.es', 'tools/path_policy.es', 'tools/edit_proposal.es', 'tools/edit_encoding.es',
           'session/edit_operation.es', 'model/model_tool_contract.es', 'harness/harness_model_contract.es',
           'harness/harness_tool_contract.es', 'harness/harness_edit_contract.es', 'harness/harness_work_contract.es',
           'cli/harness_edit_args.es', 'cli/harness_work_args.es']
sha = lambda value: hashlib.sha256(value.encode()).hexdigest()


def cases():
    checks = []
    def add(label, expressions): checks.append((label, ' && '.join(expressions)))
    read_value = dict(steps=7, calls=4, tokens=8192, tools=1, scan=4096)
    read = lambda **changes: record('ReadLedger', dict(read_value, **changes))
    edit_value = dict(steps=0, calls=0, tokens=0, native_tokens=0, boundaries=0)
    edit = lambda **changes: record('EditLedger', dict(edit_value, **changes))
    base = dict(request='update target using context', task='read context.txt', operation='read', files=['context.txt'], literal='',
                outcome='complete: blue<LF>', result='The context selects blue.', summary='Use blue from context.txt.', allowed=['context.txt'], ledger=read_value)
    def evidence(**changes):
        value = dict(base, **changes); selected = value.pop('ledger')
        return record('Evidence', value)[:-2]+', ledger = '+record('ReadLedger', selected)+' }'
    pending = dict(summary='', ledger=dict(steps=5, calls=3, tokens=6144, tools=1, scan=4096))
    search = dict(operation='search', files=['context.txt', 'other.txt'], literal='NEEDLE', allowed=['context.txt', 'other.txt'], outcome='complete: context.txt:2<LF>')
    add('valid_complete_read_evidence', ['evidence('+evidence()+', true)'])
    add('valid_search_selection_preserved', ['finish('+evidence(**dict(search, **pending))+', '+literal(base['summary'])+', '+evidence(**search)+', false)'])
    add('pending_read_becomes_exact_settled_evidence', ['finish('+evidence(**pending)+', '+literal(base['summary'])+', '+evidence()+', false)'])
    add('direct_final_and_unsupported_operation_refused', ['evidence('+evidence(**change)+', false)' for change in [dict(operation='final'), dict(operation='write'), dict(files=[]), dict(ledger=dict(steps=5, calls=3, tokens=6144, tools=0, scan=0))]])
    add('selected_paths_and_literal_refused', ['evidence('+evidence(**change)+', false)' for change in [dict(files=['outside.txt']), dict(literal='unexpected'), dict(search, literal=''), dict(search, literal='x'*65), dict(files=['context.txt']*2)]])
    add('unsupported_and_oversized_read_text_refused', ['evidence('+evidence(**change)+', false)' for change in [dict(result='蓝色'), dict(outcome='complete: x\n'), dict(result='x'*257), dict(outcome='complete: '+'x'*257), dict(summary='x'*513)]])
    add('read_request_task_127_128_129_admission', ['evidence('+evidence(request='q'*size, task='t'*size)+', '+literal(size <= 128)+')' for size in [127, 128, 129]])
    add('invalid_pending_and_summary_refused', ['finish('+evidence(**dict(pending, **change))+', '+literal(summary)+', '+evidence()+', true)' for change, summary in [(dict(), ''), (dict(), '蓝'), (dict(summary='already settled'), base['summary']), (dict(ledger=read_value), base['summary'])]])
    before, after = '\x01'*2048, '\x02'*2048
    context = dict(phase='aggregate', request=base['request'], task='replace with context blue', id='op', workspace='owned', path='target.txt', before=before, after=after,
                   request_digest='a'*64, before_digest=sha(before), after_digest=sha(after), before_bytes=2048, after_bytes=2048, completed=True)
    def work_context(change=None, proof=None): return 'Context { edit = '+record('EditContext', dict(context, **(change or {})))+', evidence = '+(proof or evidence())+' }'
    add('complete_2048_before_after_and_evidence_roundtrip', ['roundtrip('+work_context()+')', 'roundtrip('+work_context(dict(before='😀'*512, before_digest=sha('😀'*512)))+')'])
    add('request_binding_and_unconfirmed_context_refused', ['contextual('+value+', false)' for value in [work_context(dict(request='different')), work_context(dict(completed=False)), work_context(dict(after_digest='b'*64)), work_context(proof=evidence(**pending))]])
    ledger = lambda read_state=None, edit_state=None: 'Ledger { read = '+(read_state or read())+', edit = '+(edit_state or edit())+' }'
    add('fresh_reserves_both_phases_once', ['unused()'])
    add('shared_13_steps_7_calls_no_reset', ['normal_ledger('+read()+')'])
    add('partial_or_no_tool_read_cannot_start_edit', ['blocked('+ledger(value)+')' for value in [read(steps=0, calls=0, tokens=0, tools=0, scan=0), read(steps=5, calls=3, tokens=6144), read(steps=5, calls=3, tokens=6144, tools=0, scan=0)]])
    add('forged_counters_and_premature_edit_refused', ['ledger_error('+value+') != ""' for value in [ledger(read(tokens=8191)), ledger(read(scan=4095)), ledger(edit_state=edit(steps=1, calls=1, tokens=4096, native_tokens=32767)), ledger(read(steps=5, calls=3, tokens=6144), edit(steps=1, calls=1, tokens=4096, native_tokens=32768))]])
    args = ['--id', 'op', '--workspace', 'owned', '--path', 'target.txt', '--once', base['request'], '--allow', 'context.txt']
    selected = dict(help=False, id='op', workspace='owned', path='target.txt', request=base['request'])
    def arguments(values, denied=False, input_change=None, allowed=None):
        expected = 'Work { edit = '+record('Input', dict(selected, **(input_change or {})))+', allowed = '+literal(['context.txt'] if allowed is None else allowed)+' }'
        return 'arguments('+literal(values)+', '+expected+', '+literal(denied)+')'
    paths = ['a'*48, 'b'*48]
    add('cli_reordered_and_maximum_allowlist', [arguments(args[8:]+args[:8]), arguments(args[:9]+[','.join(paths)], allowed=paths), arguments(args[:7]+['q'*128]+args[8:], input_change=dict(request='q'*128))])
    add('cli_help_without_selectors', [arguments(['--help'], input_change=dict(help=True, id='', workspace='', path='', request=''), allowed=[])])
    invalid_allow = ['', 'context.txt,context.txt', 'a,b,c', 'a'*49, 'a'*48+','+'b'*49, '../outside']
    add('cli_allowlist_and_option_errors_refused', [arguments(args[:9]+[value], True) for value in invalid_allow]+[arguments(args[:4]+['--allow', 'other.txt']+args[6:], True), arguments(args[:8], True), arguments(args[:4]+['--other', 'x']+args[6:], True)])
    add('cli_narrow_ascii_read_request_refused', [arguments(args[:7]+[value]+args[8:], True) for value in ['q'*129, '蓝', 'x\n', '', '   ']])
    assert len(checks) == 18
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true'); args = parser.parse_args(); checks = cases()
    args.evidence_dir.mkdir(parents=True, exist_ok=True); evidence = Path(tempfile.mkdtemp(prefix='harness-work-contract-', dir=args.evidence_dir)); project = evidence/'project'
    (project/'src/app').mkdir(parents=True)
    for name in MODULES:
        target = project/'src/nomo'/name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT/'src/nomo'/name, target)
    expressions = ['Check { label = '+literal(label)+', passed = '+expression+' }' for label, expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__', '['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe', 'harness-work-contract-probe'))
    result = dict(task='HARNESS-WORK-001A-pure', status='prepared', checks=[label for label, _ in checks], commands=[])
    output = evidence/'results.json'; save = lambda: output.write_text(json.dumps(result, indent=2)+'\n')
    save(); print('EVIDENCE '+str(evidence), flush=True)
    if args.prepare_only: return
    try:
        cli = verify_cli(); count = len(list((project/'src').rglob('*.es')))
        for label, argv, expected in [('check', [cli, 'check', '--all', project], 'checked '+str(count)+' files\n'), ('effects', [cli, 'effects', project, '--flow', 'pure_probe'], None),
            ('observe', [cli, 'run', project, '--flow', 'observe', '--allow-effects'], ''.join('PASS '+label+'\n' for label, _ in checks))]:
            item = dict(label=label, command=list(map(str, argv))); result['commands'].append(item); save(); observed = subprocess.run(item['command'], capture_output=True, timeout=180)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout); (evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode()); save(); assert observed.returncode == 0 and not observed.stderr, item
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
    print('PASS 18 grouped pure harness work checks', flush=True)


if __name__ == '__main__': main()
