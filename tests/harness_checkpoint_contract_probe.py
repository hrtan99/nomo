#!/usr/bin/env python3
"""Synthetic checkpoint defenses; not actual Model/File/Memory executions."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from normal_graph_identity import bootstrap_evidence_paths, verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/harness_session001/contract_probe.es'
MODULES = ['core/text.es', 'core/conversation.es', 'tools/path_policy.es', 'tools/edit_encoding.es',
           'model/model_tool_contract.es', 'harness/harness_model_contract.es', 'harness/model_plan_diagnostic.es',
           'harness/harness_tool_contract.es', 'harness/harness_tool_chat_contract.es',
           'session/harness_checkpoint.es']
KEYS = ['steps', 'calls', 'tokens', 'tools', 'scan']
DEFAULT = [14, 8, 16384, 2, 8192]
RESERVE = [7, 4, 8192, 1, 4096]
DIRECT = [5, 3, 6144, 0, 0]
TOOL = [7, 4, 8192, 1, 4096]
PROVISIONAL_HOST_CONSTRUCTION = {
    'scope': 'superseded provisional host construction only; no Etas execution',
    'checks': 205,
    'runner_sha256': '3a9f9bf92ab1f8aa0d79584fe16cc11ab1fbc13625ff396f9e3a2527e59194fa',
    'fixture_sha256': 'db9ee64202d192221f0df9b51e72e06d7dab08f61a9c2648b8c84361f396cde0',
    'superseded_bounds': dict(raw=16384, string_fields=77, narrowed_maximum_accepted=True),
}
SOURCE_LITERAL_CORRECTION = {
    'scope': 'test source representation correction; product codec and all 205 logical oracles unchanged',
    'failed_runner_sha256': '99e5f17e35f1f96992d2629801df1b41e8b3c8f0181bb26768d8ebc03c77024b',
    'failed_fixture_sha256': 'db9ee64202d192221f0df9b51e72e06d7dab08f61a9c2648b8c84361f396cde0',
    'failed_generated_source_sha256': 'd7a1023f3a648daed243f58c328f1bfc5e886dddebe20515ca5a6512d91ee7d1',
    'failed_result_sha256': '6df5558e47a20e27b4e36639fa0c73d0cde68397e8d1443917a9076403366790',
    'failed_observe_stdout_sha256': '0809298091bc418c1b8853f7d138a82b976a8d3b9872ea1a0d1ae225d83ae4a3',
    'diagnostic_source_sha256': 'e1371907437fa64d36c1b3d1f1ac30607c9b61b31a3fc6ccd56c510ec88ac93f',
    'diagnostic_stdout_sha256': '8293e32faadfe9e9b7a2fd4f00457630be2844d64519f1be353e453e79a42e46',
    'diagnostic_result_sha256': 'c39a8107ca8e76f730605e4145d62a8a5b89228a6a0e99d3cb9280a4fd3596ba',
    'diagnosis': 'record source order differed; after ordering correction deep values matched but nested JSON source backslashes did not',
}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def source_literal(value):
    """Emit Etas source separately from the independent wire JSON oracle."""
    if isinstance(value, str):
        return ' + slash() + '.join(json.dumps(part, ensure_ascii=False) for part in value.split('\\'))
    if isinstance(value, list):
        return '[' + ', '.join(source_literal(item) for item in value) + ']'
    return encoded(value)


def record(name, **fields):
    return name + ' { ' + ', '.join(key + ' = ' + value for key, value in fields.items()) + ' }'


def ledger(values):
    return record('Ledger', **{key: str(number) for key, number in zip(KEYS, values)})


def identity(**changes):
    value = dict(id='checkpoint-1', workspace='fixture-v1', allowed=['docs/a.txt'])
    value.update(changes)
    return value


def event(role, kind, name='', text=''):
    return dict(role=role, kind=kind, name=name, text=text)


def completed_records(value, raw_plan=None, action=None):
    rows = [event('user', 'request', text=value['request']),
            event('main', 'plan', text=raw_plan or encoded(['delegate', value['task']])),
            event('main', 'delegate', 'child-1', value['task']),
            event('user', 'context', 'original', value['request']),
            event('user', 'input', text=value['task']), event('model', 'text', 'qwen')]
    if value['tool']:
        action = action or ([value['tool'], value['identity']['allowed'][0]] if value['tool'] == 'read'
                            else [value['tool'], 'NEEDLE', *value['identity']['allowed']])
        rows += [event('model', 'request', value['tool'], encoded(action)),
                 event('tool', 'complete', value['tool'], value['outcome']), event('model', 'text', 'qwen')]
    rows += [event('assistant', 'final', text=value['result']),
             event('main', 'consume', 'child-1', value['result'])]
    if value['tool']:
        rows.append(event('main', 'tool', value['tool'], value['outcome']))
    return rows + [event('main', 'answer', text=value['answer'])]


def checkpoint(**changes):
    value = dict(format=1, identity=identity(), request='original question', task='delegated task',
                 result='selected child', tool='', outcome='', answer='selected parent', usage=list(DIRECT),
                 maximum=list(DEFAULT), admitted=1, lifecycle='completed', resolved=True)
    value.update(deepcopy(changes))
    value.setdefault('records', completed_records(value))
    return value


def expression(value):
    fields = {}
    order = ['format', 'identity', 'request', 'task', 'result', 'tool', 'outcome', 'answer',
             'records', 'usage', 'maximum', 'admitted', 'lifecycle', 'resolved']
    assert set(value) == set(order), 'checkpoint fixture must contain every declared field exactly'
    for key in order:
        item = value[key]
        if key == 'identity':
            fields[key] = record('Identity', **{name: source_literal(data) for name, data in item.items()})
        elif key in ['usage', 'maximum']:
            fields[key] = ledger(item)
        elif key == 'records':
            fields[key] = '[' + ', '.join('event(' + ', '.join(source_literal(row[name]) for name in
                                         ['role', 'kind', 'name', 'text']) + ')' for row in item) + ']'
        else:
            fields[key] = source_literal(item)
    return record('Checkpoint', **fields)


def flat(value):
    """Independent versioned string-array encoding oracle; header is fixed width."""
    allowed = value['identity']['allowed']
    header = ['nomo-harness-checkpoint-v1', value['identity']['id'], value['identity']['workspace'],
              allowed[0], allowed[1] if len(allowed) == 2 else '', value['request'], value['task'],
              value['result'], value['tool'], value['outcome'], value['answer'],
              *map(str, value['usage']), *map(str, value['maximum']), str(value['admitted']),
              value['lifecycle'], 'true' if value['resolved'] else 'false', str(len(value['records']))]
    return header + [row[key] for row in value['records'] for key in ['role', 'kind', 'name', 'text']]


def cases():
    values = []
    direct = checkpoint()
    tool = checkpoint(tool='read', outcome='complete: observed data', usage=list(TOOL))

    def add(label, mode='validate', accepted=True, saved=None, requested=None, raw='', turn=None, expected=None):
        saved = deepcopy(direct if saved is None else saved)
        requested = deepcopy(saved['identity'] if requested is None else requested)
        saved_expr = expression(saved)
        fields = dict(label=source_literal(label), mode=source_literal(mode), saved=saved_expr,
                      requested=record('Identity', **{key: source_literal(data) for key, data in requested.items()}),
                      turn=turn or 'receipt(' + saved_expr + ', 0, true, true)', raw=source_literal(raw),
                      accepted=str(accepted).lower(), expected=expression(saved if expected is None else expected))
        values.append((label, record('Check', **fields)))

    for label, saved in [('direct9', direct), ('read13', tool),
                         ('search13', checkpoint(tool='search', outcome='complete: docs/a.txt:1', usage=list(TOOL))),
                         ('empty_complete', checkpoint(tool='read', outcome='complete: ', usage=list(TOOL))),
                         ('markers_are_data', checkpoint(tool='read', outcome='complete: <LT>read<LF>', usage=list(TOOL))),
                         ('escaped_printable_data', checkpoint(request='Q"\\data', task='T"\\data',
                                                              result='R"\\data', answer='A"\\data')),
                         ('preserve_edge_spaces', checkpoint(request='  Q  ', task=' T ', result=' R ', answer=' A ')),
                         ('independent_narrow_caps', checkpoint(maximum=[8, 4, 8192, 1, 4096])),
                         ('exact_reservation_caps', checkpoint(maximum=list(RESERVE))),
                         ('tool_exhausts_narrow_caps', checkpoint(tool='read', outcome='complete: data',
                                                               usage=list(TOOL), maximum=list(RESERVE)))]:
        accepted = saved['maximum'] == DEFAULT
        add(label, saved=saved, accepted=accepted)
        add('roundtrip_' + label, mode='roundtrip', saved=saved, raw=encoded(flat(saved)), accepted=accepted)
        add('receipt_' + label, mode='from_turn', saved=saved, accepted=accepted)
    spaced = checkpoint()
    spaced['records'] = completed_records(spaced, raw_plan='[ "delegate", "delegated task" ]')
    add('preserve_actual_plan_encoding', mode='roundtrip', saved=spaced, raw=encoded(flat(spaced)))
    for size in [384,385]:
        saved=deepcopy(direct);raw_plan=encoded(['delegate',saved['task']])
        saved['records'][1]['text']=raw_plan+' '*(size-len(raw_plan))
        add('raw_plan_'+str(size),accepted=size==384,saved=saved)
        saved=deepcopy(tool);raw_action=encoded(['read',saved['identity']['allowed'][0]])
        saved['records'][6]['text']=raw_action+' '*(size-len(raw_action))
        add('raw_action_'+str(size),accepted=size==384,saved=saved)
    bounds = checkpoint(identity=identity(id='I'*128, workspace='W'*128, allowed=['a'*44+'.txt', 'b'*44+'.txt']),
                        request='Q'*128, task='T'*128, result='R'*256, tool='read',
                        outcome='complete: '+'x'*256, answer='A'*512, usage=list(TOOL))
    add('maximum_field_lengths', saved=bounds)
    add('roundtrip_maximum_fields', mode='roundtrip', saved=bounds, raw=encoded(flat(bounds)))
    for field, bad in [('format', 0), ('format', 2), ('request', ''), ('request', 'Q'*129),
                       ('request', ' '), ('request', 'Q\nR'), ('task', 'T'*129), ('task', ''),
                       ('result', ''), ('result', 'R'*257), ('result', '\t'),
                       ('answer', ''), ('answer', 'A'*513), ('answer', ' '),
                       ('lifecycle', 'active'), ('lifecycle', 'pending'), ('lifecycle', 'recovery-required'),
                       ('resolved', False), ('admitted', 0), ('admitted', 2), ('admitted', 2147483647)]:
        saved = checkpoint(**{field: bad})
        suffix = str(bad) if isinstance(bad, (int, bool)) else str(len(bad))+'_'+str(len(values))
        add('invalid_'+field+'_'+suffix, accepted=False, saved=saved)
        if field in ['format', 'resolved', 'admitted']:
            add('encode_invalid_'+field+'_'+suffix, mode='encode', accepted=False, saved=saved)
    for label, supplied in [('id_empty', identity(id='')), ('id129', identity(id='I'*129)),
                            ('id_control', identity(id='I\n')), ('workspace_empty', identity(workspace='')),
                            ('workspace129', identity(workspace='W'*129)), ('workspace_control', identity(workspace='W\t')),
                            ('allow_empty', identity(allowed=[])), ('allow_three', identity(allowed=['a','b','c'])),
                            ('allow_duplicate', identity(allowed=['a','a'])), ('allow49', identity(allowed=['a'*49])),
                            ('allow_parent', identity(allowed=['../a'])), ('allow_absolute', identity(allowed=['/a']))]:
        add(label, mode='identity', accepted=False, requested=supplied)
    for label, requested in [('wrong_id',identity(id='another-id')), ('wrong_workspace',identity(workspace='another-workspace')),
                             ('wrong_allow',identity(allowed=['docs/b.txt'])),
                             ('extra_allow',identity(allowed=['docs/a.txt','docs/b.txt']))]:
        add(label, accepted=False, requested=requested)
    for label, changes in [('direct_outcome',dict(outcome='complete: old')),
                           ('unsupported_tool',dict(tool='command',outcome='complete: old',usage=list(TOOL))),
                           ('incomplete_outcome',dict(tool='read',outcome='truncated: data',usage=list(TOOL))),
                           ('outcome267',dict(tool='read',outcome='complete: '+'x'*257,usage=list(TOOL))),
                           ('tool_empty_outcome',dict(tool='read',outcome='',usage=list(TOOL)))]:
        add(label, accepted=False, saved=checkpoint(**changes))
    for owner, base in [('usage',DIRECT), ('maximum',DEFAULT)]:
        for i, key in enumerate(KEYS):
            for bad in [-1,2147483647]:
                counters=list(base);counters[i]=bad
                add(owner+'_'+key+'_'+str(bad),accepted=False,saved=checkpoint(**{owner:counters}))
    for i,key in enumerate(KEYS):
        narrow=list(RESERVE);narrow[i]-=1
        add('maximum_below_reservation_'+key,accepted=False,saved=checkpoint(maximum=narrow))
        wrong=list(DIRECT);wrong[i]+=1
        add('incorrect_direct_'+key,accepted=False,saved=checkpoint(usage=wrong))
    add('tool_counters_with_direct_records',accepted=False,saved=checkpoint(usage=list(TOOL)))
    add('direct_counters_with_tool_records',accepted=False,saved=checkpoint(tool='read',outcome='complete: data'))
    for label, mutate in [('drop_record',lambda rows:rows.pop()), ('duplicate_record',lambda rows:rows.append(deepcopy(rows[-1]))),
                          ('reordered',lambda rows:rows.reverse()),
                          ('wrong_original',lambda rows:rows[3].update(text='another original')),
                          ('wrong_delegate',lambda rows:rows[2].update(text='another task')),
                          ('wrong_rawplan',lambda rows:rows[1].update(text='["delegate","another task"]')),
                          ('empty_plan',lambda rows:rows[1].update(text='')),
                          ('unsupported_plan',lambda rows:rows[1].update(text='["read","docs/a.txt"]')),
                          ('nested_plan',lambda rows:rows[1].update(text='["delegate",["delegated task"]]')),
                          ('wrong_input',lambda rows:rows[4].update(text='another task')),
                          ('wrong_model',lambda rows:rows[5].update(name='other-model')),
                          ('wrong_result',lambda rows:rows[6].update(text='another result')),
                          ('wrong_consume',lambda rows:rows[7].update(text='another result')),
                          ('wrong_parent',lambda rows:rows[8].update(text='another answer')),
                          ('error_record',lambda rows:rows[6].update(role='error',kind='error'))]:
        saved=deepcopy(direct);mutate(saved['records']);add('record_'+label,accepted=False,saved=saved)
    for index in range(9):
        for field in ['role','kind','name']:
            saved=deepcopy(direct);saved['records'][index][field]='forged'
            add('record_'+str(index)+'_'+field,accepted=False,saved=saved)
    for label,index,field,bad in [('unallowed_read',6,'text','["read","docs/b.txt"]'),
                                 ('wrong_action_kind',6,'name','search'), ('wrong_action_verb',6,'text','["command","docs/a.txt"]'),
                                 ('incomplete_tool',7,'kind','error'), ('altered_outcome',7,'text','complete: altered'),
                                 ('missing_second_model',8,'role','assistant'), ('wrong_tool_consume',10,'text','altered'),
                                 ('wrong_selected_tool',11,'name','search'), ('wrong_selected_outcome',11,'text','complete: altered')]:
        saved=deepcopy(tool);saved['records'][index][field]=bad;add('tool_record_'+label,accepted=False,saved=saved)
    for status,resolved,present in [(1,True,True),(0,False,True),(0,True,False),(1,False,False)]:
        add('receipt_'+str(status)+'_'+str(resolved)+'_'+str(present),mode='from_turn',accepted=False,
            turn='receipt('+expression(direct)+', '+str(status)+', '+str(resolved).lower()+', '+str(present).lower()+')')
    for label, changes in [('two_admitted',dict(admitted=2)),('empty_usage',dict(usage=[0]*5)),
                           ('bad_records',dict(records=[]))]:
        add('receipt_'+label,mode='from_turn',accepted=False,saved=checkpoint(**changes))

    # Flat-array framing boundaries are byte-for-byte inputs to the product codec.
    raw=encoded(flat(tool));assert len(flat(tool))==77 and len(flat(direct))==61
    for size in [65536,65537]:
        padded=raw+' '*(size-len(raw));assert len(padded.encode())==size
        add('decode_raw_'+str(size),mode='decode',accepted=size==65536,saved=tool,raw=padded)
    add('decode_77_leaves',mode='decode',saved=tool,raw=raw)
    add('decode_81_leaves',mode='decode',accepted=False,raw=encoded(flat(tool)+['extra']*4))
    for label,bad in [('empty',''),('object','{}'),('scalar','"value"'),('numeric','[1]'),
                      ('deep','['*1000+'"x"'+']'*1000),('trailing_data',encoded(flat(direct))+'null')]:
        add('decode_'+label,mode='decode',accepted=False,raw=bad)
    for label,index,bad in [('unknown_version',0,'nomo-harness-checkpoint-v2'),('old_bundle',0,'nomo-session-bundle-v1'),
                          ('negative_steps',11,'-1'),('leading_zero_steps',11,'05'),('plus_steps',11,'+5'),
                          ('space_steps',11,' 5'),('overflow_steps',11,'2147483648'),('huge_steps',11,'9'*500),
                          ('fraction_steps',11,'5.0'),('empty_steps',11,''),('nondecimal_steps',11,'0x5'),
                          ('true_as_one',23,'1'),('uppercase_true',23,'TRUE'),('count_leading_zero',24,'09'),
                          ('wrong_count',24,'13'),('count14',24,'14')]:
        fields=flat(direct);fields[index]=bad
        add('decode_'+label,mode='decode',accepted=False,raw=encoded(fields))
    for label,fields in [('missing_header',flat(direct)[:24]),('missing_record_field',flat(direct)[:-1]),
                          ('nested_leaf',flat(direct)),('number_leaf',flat(direct))]:
        if label=='nested_leaf':fields[5]=['nested']
        if label=='number_leaf':fields[11]=5
        add('decode_'+label,mode='decode',accepted=False,raw=encoded(fields))
    assert 0<len(values)<=256 and len(values)==len({label for label,_ in values})
    return values


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


BATCH_SIZE = 32
MANIFEST = '''[package]
name = "harness-checkpoint-contract-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "harness-checkpoint-contract-probe"
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
'''


def batches(values):
    assert len(values)==205 and len({label for label,_ in values})==205
    return [(offset,values[offset:offset+BATCH_SIZE]) for offset in range(0,len(values),BATCH_SIZE)]


def generated(template, values):
    assert template.count('__CHECKS__')==1
    return template.replace('__CHECKS__','['+',\n'.join(body for _,body in values)+']')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--etas',required=True,type=Path)
    parser.add_argument('--evidence-dir',required=True,type=Path)
    parser.add_argument('--prepare-only',action='store_true')
    args=parser.parse_args()
    assert args.etas.is_absolute()
    cli=args.etas if args.prepare_only else verify_cli()
    assert args.prepare_only or cli.resolve()==args.etas.resolve()
    evidence=Path(tempfile.mkdtemp(prefix='harness-checkpoint-contract-',dir=args.evidence_dir))
    print('EVIDENCE '+str(evidence),flush=True)
    paths=[ROOT/'src/nomo'/name for name in MODULES]+[Path(__file__).resolve(),FIXTURE,
           ROOT/'tests/normal_graph_identity.py',*bootstrap_evidence_paths(),ROOT/'config/etas-latest-main.json',ROOT/'etas.lock']
    frozen={str(p.relative_to(ROOT)):digest(p) for p in paths}
    for source in paths:
        target=evidence/'inputs'/source.relative_to(ROOT);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        assert digest(target)==frozen[str(source.relative_to(ROOT))],'input changed during freeze'
    values=cases();groups=batches(values)
    template=(evidence/'inputs'/FIXTURE.relative_to(ROOT)).read_text()
    result=dict(scope='synthetic checkpoint contracts; no actual Model/File/Memory execution claim',
                status='prepared' if args.prepare_only else 'running',prepared_only=args.prepare_only,
                checks=[label for label,_ in values],inputs=frozen,batches=[],observed_checks=[],
                root_lock_provenance_only=True,commands=[],
                case_matrix_sha256=hashlib.sha256(encoded(values).encode()).hexdigest(),
                batch_size=BATCH_SIZE,per_command_timeout_seconds=180,
                superseded_provisional_host_construction=PROVISIONAL_HOST_CONSTRUCTION,
                source_literal_correction=SOURCE_LITERAL_CORRECTION,
                codec_bounds=dict(raw=65536, string_fields=80, per_field=1024, aggregate_decoded=8192,
                                  valid_arities=[61,77], maximum=list(DEFAULT)))
    for index,(offset,group) in enumerate(groups):
        directory=evidence/'batches'/f'{index:03d}';project=directory/'project'
        for name in MODULES:
            target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(evidence/'inputs/src/nomo'/name,target)
        source=project/'src/app/contract_probe.es';source.parent.mkdir(parents=True)
        source.write_text(generated(template,group))
        # The root lock remains provenance; each fresh package owns its own lock.
        (project/'etas.toml').write_text(MANIFEST)
        result['batches'].append(dict(index=index,offset=offset,checks=[label for label,_ in group],
                                      project=str(project.relative_to(evidence)),generated_source_sha256=digest(source),
                                      status='prepared' if args.prepare_only else 'not_run',command_indices=[]))
    assert [label for batch in result['batches'] for label in batch['checks']]==result['checks']
    output=evidence/'results.json'
    def save():output.write_text(json.dumps(result,indent=2)+'\n')
    save()
    if args.prepare_only:return
    result['identity']=dict(executable=str(cli),sha256=digest(cli));save()
    try:
        for batch in result['batches']:
            batch['status']='running';project=evidence/batch['project'];directory=project.parent;trace_path=directory/'trace.json';save()
            for name,arguments in [('check',['check','--all',str(project)]),('pure-effects',['effects',str(project),'--flow','pure_probe']),
                                   ('observe',['run',str(project),'--flow','observe','--allow-effects','--trace-out',str(trace_path)])]:
                assert {str(p.relative_to(ROOT)):digest(p) for p in paths}==frozen,'root input drift'
                inputs=[project/'etas.toml',*sorted((project/'src').rglob('*.es'))]
                if (project/'etas.lock').exists():inputs.append(project/'etas.lock')
                item=dict(label=f'batch-{batch["index"]:03d}-'+name,kind=name,batch=batch['index'],
                          project=batch['project'],status='running',command=[str(cli),*arguments],
                          inputs={str(p.relative_to(project)):digest(p) for p in inputs})
                batch['command_indices'].append(len(result['commands']));result['commands'].append(item);save()
                try:run=subprocess.run(item['command'],capture_output=True,timeout=180)
                except subprocess.TimeoutExpired as error:
                    for label,raw in [('stdout',error.stdout or b''),('stderr',error.stderr or b'')]:
                        path=directory/(name+'.'+label+'.bin');path.write_bytes(raw)
                        item[label+'_sha256']=digest(path);item[label+'_retained']=str(path.relative_to(evidence))
                    item.update(timeout=True,exit=None);save();raise
                for label,raw in [('stdout',run.stdout),('stderr',run.stderr)]:
                    path=directory/(name+'.'+label+'.bin');path.write_bytes(raw);item[label+'_sha256']=digest(path)
                    item[label+'_retained']=str(path.relative_to(evidence))
                item.update(exit=run.returncode,timeout=False,stdout=run.stdout.decode(),stderr=run.stderr.decode());save()
                assert run.returncode==0 and not run.stderr,item
                assert all(digest(project/p)==h for p,h in item['inputs'].items()),'project input drift'
                if name=='pure-effects':assert 'requested actions: []' in item['stdout'] and 'default actions: []' in item['stdout']
                if name=='observe':
                    assert item['stdout'].splitlines()==['PASS '+label for label in batch['checks']]
                    trace=json.loads(trace_path.read_text())
                    starts=[e for e in trace['events'] if e['kind']=='host_request_started']
                    assert {e['qualified_action'] for e in starts}<={'Policy.evaluate','Console.stdout_write'}
                    assert sum(e['qualified_action']=='Console.stdout_write' for e in starts)==len(batch['checks'])
                    batch.update(trace_sha256=digest(trace_path),trace_retained=str(trace_path.relative_to(evidence)))
                    result['observed_checks'].extend(line[len('PASS '):] for line in item['stdout'].splitlines())
                item['status']='passed';save()
            batch['status']='passed';save()
        assert result['observed_checks']==result['checks'] and len(set(result['observed_checks']))==205
        assert len(result['commands'])==3*len(groups) and all(b['status']=='passed' for b in result['batches'])
        assert {str(p.relative_to(ROOT)):digest(p) for p in paths}==frozen
        assert digest(cli)==result['identity']['sha256'],'CLI input drift'
        result.update(status='passed',inputs_unchanged=True);save()
        print('PASS '+str(len(values))+' pure checkpoint checks in '+str(len(groups))+' serial batches; synthetic contracts only',flush=True)
    except BaseException as error:
        if 'item' in locals() and item['status']!='passed':item['status']='failed'
        if 'batch' in locals() and batch['status']!='passed':batch['status']='failed'
        result.update(status='failed',failure=repr(error));save();raise


if __name__=='__main__':main()
