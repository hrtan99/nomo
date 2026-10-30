#!/usr/bin/env python3
"""Focused actual Etas work-record codec checks; no provider or storage effects."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from edit_contract_probe import literal, record
from edit_write_probe import ascii_json
from harness_checkpoint_contract_probe import MANIFEST
from harness_work_contract_probe import MODULES as WORK_MODULES
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/work_record001/contract_probe.es'
MODULES = WORK_MODULES + ['model/tool_context.es', 'tools/edit_contract.es', 'tools/edit_file.es', 'tools/edit_binding.es', 'session/work_record.es', 'harness/edit_original.es']
REGION = 'nomo.tools.edit_file.EditableRoot'
sha = lambda value: hashlib.sha256(value.encode()).hexdigest()
READ = dict(steps=7, calls=4, tokens=8192, tools=1, scan=4096)
BASE = dict(request='update target using context', task='read context.txt', operation='read', files=['context.txt'], literal='',
            outcome='complete: blue<LF>', result='The context selects blue.', summary='Use blue from context.txt.', allowed=['context.txt'])


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


def cases():
    checks = []
    def add(label, expressions): checks.append((label, ' && '.join(expressions)))
    def binding(value): return record('Binding', value)
    def evidence(value): return record('Evidence', value)[:-2]+', ledger = '+record('ReadLedger', READ)+' }'
    def roundtrip(value):
        return 'roundtrip('+', '.join([binding(value['binding']), evidence(value['evidence']),
            *[literal(value[key]) for key in ['task', 'before', 'after', 'target', 'replacement', 'summary', 'fields', 'complete']]])+')'
    base = projection(); b = binding(base['binding']); values = base['fields']
    def fields(value, accepted=False, phase='summary-unconfirmed', format=1, selected=None):
        return 'fields('+binding(selected or base['binding'])+', '+literal(phase)+', '+str(format)+', '+literal(value)+', '+literal(accepted)+')'
    def changed(index, value):
        data = list(values); data[index] = value; return fields(data)
    add('ascii_partial_and_confirmed_projection', [roundtrip(base)])
    search = dict(BASE, operation='search', files=['context.txt', 'other.txt'], allowed=['context.txt', 'other.txt'], literal='NEEDLE', outcome='complete: context.txt:2<LF>')
    add('search_two_paths_and_literal_preserved', [roundtrip(projection(evidence=search))])
    add('empty_replacement_and_zero_after_bytes', [roundtrip(projection(before='old', replacement=''))])
    add('unicode_exact_2048_utf8_bytes_preserved', [roundtrip(projection(before='😀'*512, target='😀'*512, replacement='前'*682+'ab', summary='已完成😀'))])
    add('control_exact_2048_bytes_and_worst_summary_admitted', [roundtrip(projection(before='\x01'*2048, target='\x01'*2048, replacement='\x02'*2048, summary='A'+'\x01'*511))])
    maximal = dict(BASE, request='q'*128, task='r'*128, operation='search', files=['a'*48, 'b'*48], allowed=['a'*48, 'b'*48], literal='l'*64,
                   outcome='complete: '+'o'*256, result='x'*256, summary='s'*512)
    extreme = projection(before='\x01'*2048, target='\x01'*2048, replacement='\x02'*2048, task='T'+'\x03'*511, summary='S'+'\x04'*511,
                         evidence=maximal, id='i'*128, workspace='w'*128, path='p'*128)
    assert sum(len(item.encode()) for item in extreme['complete']) <= 12288
    assert len(ascii_json(extreme['complete']).encode()) <= 65536
    add('complete_supported_maximum_row_and_second_escaping_admitted', [roundtrip(extreme)])
    add('unsupported_outer_format_or_phase_refused', [fields(values, format=2), fields(values, phase='edit-completed'), fields(values, phase='summary-confirmed')])
    add('marker_and_outer_body_phase_disagreement_refused', [changed(0, 'nomo-work-record-v2'), changed(1, 'summary-confirmed')])
    add('every_outer_binding_field_disagreement_refused', [fields(values, selected=dict(base['binding'], **{key: value})) for key, value in
        [('id','other'), ('workspace','other'), ('path','other.txt'), ('region','wrong'), ('request_digest','a'*64),
         ('before_digest','b'*64), ('after_digest','c'*64), ('before_bytes',3), ('after_bytes',1)]])
    add('inner_binding_identity_and_digests_refused', [changed(index, value) for index, value in [(2,'other'),(3,'other'),(4,'wrong'),(5,'../out'),(6,'a'*64),(7,'b'*64),(8,'c'*64),(9,'04'),(10,'05')]])
    add('literal_edit_target_replacement_and_after_binding_refused', [changed(index,value) for index,value in [(23,''),(23,'missing'),(24,'red'),(25,'old old\n'),(26,'forged'),(27,'unconfirmed summary')]])
    add('every_read_edit_maximum_reservation_counter_exact', [changed(index, str(int(values[index])+1)) for index in range(28,52)])
    add('counter_canonical_decimal_required', [changed(index,value) for index,value in [(28,'07'),(29,'+4'),(30,'8192.0'),(33,'-5'),(36,'098304'),(41,'196608 '),(48,'true'),(51,'0x10000')]])
    add('all_52_fields_required', [fields(values[:-1]),fields(values+['extra']),fields([])])
    bad_raw = [json.dumps([['nested']]+values[1:]), json.dumps([0]+values[1:]), '{}', 'null', '[', '["unterminated]',
               json.dumps(values)[:-1], json.dumps(values)+',', json.dumps(values).replace('"nomo-work-record-v1"','"bad\\q"',1)]
    add('nested_nonstring_truncated_and_invalid_json_refused', ['body('+b+', "summary-unconfirmed", 1, '+literal(raw)+', false)' for raw in bad_raw])
    add('encoded_65536_byte_boundary_exact', ['padding('+b+', '+literal(values)+', 65536, true)', 'padding('+b+', '+literal(values)+', 65537, false)'])
    add('decoded_per_field_utf8_not_scalar_count', [changed(11,'q'*2049),changed(25,'前'*683),changed(23,'😀'*513),changed(24,'x'*2049)])
    excessive = list(values); excessive[11:18] = ['x'*2048]*7
    assert sum(len(item.encode()) for item in excessive) > 12288
    add('decoded_total_12288_byte_bound_refused', [fields(excessive)])
    add('narrow_read_request_task_path_literal_result_summary_rules', [changed(index,value) for index,value in
        [(11,'q'*129),(11,'蓝'),(12,'r'*129),(14,'a'*49),(16,'outside.txt'),(18,'unexpected'),(19,'complete: '+'o'*257),(20,'x'*257),(21,'s'*513),(22,'t'*513)]])
    add('invalid_summary_blank_nul_and_utf8_oversize_refused', ['summary('+b+', '+literal(values)+', '+literal(value)+', false)' for value in ['', '   ', '\x00', 'x'*513, '前'*171]])
    add('confirmed_stage_summary_and_reservation_must_agree', [fields(base['complete'], True, phase='summary-confirmed'),
        fields(base['complete'], phase='summary-unconfirmed'), fields(base['complete'][:27]+['']+base['complete'][28:], phase='summary-confirmed')])
    add('raw_unicode_json_frame_is_supported', ['body('+binding(projection(before='前😀',target='前',replacement='新')['binding'])+', "summary-unconfirmed", 1, '+
        literal(json.dumps(projection(before='前😀',target='前',replacement='新')['fields'],ensure_ascii=False,separators=(',',':')))+', true)'])
    assert len(checks) <= 40 and len({label for label,_ in checks}) == len(checks)
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args(); checks = cases()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='work-record-contract-',dir=args.evidence_dir)); project = evidence/'project'
    (project/'src/app').mkdir(parents=True)
    for name in MODULES:
        target = project/'src/nomo'/name; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(ROOT/'src/nomo'/name,target)
    expressions = ['Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','work-record-contract-probe'))
    result = dict(task='HARNESS-WORK-SESSION-001A-pure',status='prepared',checks=[label for label,_ in checks],commands=[])
    output = evidence/'results.json'; save = lambda: output.write_text(json.dumps(result,indent=2)+'\n')
    save(); print('EVIDENCE '+str(evidence),flush=True)
    if args.prepare_only: return
    try:
        cli = verify_cli(); count = len(list((project/'src').rglob('*.es')))
        for label,argv,expected in [('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),
            ('effects',[cli,'effects',project,'--flow','pure_probe'],None),
            ('observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+label+'\n' for label,_ in checks))]:
            item = dict(label=label,command=list(map(str,argv))); result['commands'].append(item); save()
            observed = subprocess.run(item['command'],capture_output=True,timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout); (evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode()); save()
            diagnostic = dict(label=label, exit=observed.returncode, stdout=str(evidence/(label+'.stdout.bin')), stderr=str(evidence/(label+'.stderr.bin')))
            assert observed.returncode == 0 and not observed.stderr,diagnostic
            if expected is None:
                assert item['stdout'].count('requested actions: []') == item['stdout'].count('default actions: []') == 1,diagnostic
            else: assert item['stdout'] == expected,diagnostic
        result['status'] = 'passed'
    except BaseException as error: result.update(status='failed',failure=repr(error)); raise
    finally:
        result['resources'] = {name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
        resource = result['resources']; events = dict(line.split() for line in resource['memory.events'].splitlines())
        valid = resource['memory.max'] == '4294967296' and resource['cpu.max'] == '400000 100000' and resource['pids.max'] == '256' and all(events[key] == '0' for key in ['max','oom','oom_kill','oom_group_kill'])
        if not valid: result.update(status='failed',resource_failure='ordinary resource guard failed')
        save(); assert valid,dict(resource_failure='ordinary resource guard failed', evidence=str(output))
    print('PASS '+str(len(checks))+' grouped pure work record checks',flush=True)


if __name__ == '__main__': main()
