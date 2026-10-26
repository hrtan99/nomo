#!/usr/bin/env python3
"""Synthetic pure successor contracts; no actual Model/File/Memory execution."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

import harness_checkpoint_contract_probe as first
from normal_graph_identity import bootstrap_path, verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/harness_session001b/contract_probe.es'
MODULES = first.MODULES + ['session/harness_successor.es', 'cli/harness_successor_args.es']
KEYS, DEFAULT, DIRECT, TOOL = first.KEYS, first.DEFAULT, first.DIRECT, first.TOOL
encoded, record, ledger = first.encoded, first.record, first.ledger
event = first.event


def source_literal(value):
    """Keep source-only string concatenation balanced; wire values are unchanged."""
    if isinstance(value,str):
        pieces=[]
        for index,part in enumerate(value.split('\\')):
            if index:pieces.append('slash()')
            pieces.append(json.dumps(part,ensure_ascii=False))
        def balanced(start,stop):
            if stop-start==1:return pieces[start]
            middle=(start+stop)//2
            return '('+balanced(start,middle)+' + '+balanced(middle,stop)+')'
        return balanced(0,len(pieces))
    if isinstance(value,list):return '['+', '.join(source_literal(item) for item in value)+']'
    return encoded(value)


def identity(**changes):
    value = first.identity(id='successor-1'); value.update(changes)
    return value


def completed_records(value):
    prior = value['predecessor']
    rows = [event('user', 'request', text=value['request']),
            event('main', 'plan', text=encoded(['delegate', value['task']])),
            event('main', 'delegate', 'child-1', value['task']),
            event('user', 'context', 'original', value['request'])]
    rows += [event('user', 'context', key, prior[key]) for key in ['task', 'result', 'tool', 'outcome', 'answer']]
    rows += [event('user', 'input', text=value['task']), event('model', 'text', 'qwen')]
    if value['tool']:
        action = [value['tool'], value['identity']['allowed'][0]] if value['tool'] == 'read' else \
                 [value['tool'], 'NEEDLE', *value['identity']['allowed']]
        rows += [event('model', 'request', value['tool'], encoded(action)),
                 event('tool', 'complete', value['tool'], value['outcome']), event('model', 'text', 'qwen')]
    rows += [event('assistant', 'final', text=value['result']), event('main', 'consume', 'child-1', value['result'])]
    if value['tool']:
        rows.append(event('main', 'tool', value['tool'], value['outcome']))
    return rows + [event('main', 'answer', text=value['answer'])]


def successor(**changes):
    prior = deepcopy(changes.pop('predecessor', first.checkpoint()))
    value = dict(format=1, identity=identity(workspace=prior['identity']['workspace'], allowed=prior['identity']['allowed']),
                 predecessor=prior, predecessor_version='actual-opaque-version', request='second question', task='second delegated task',
                 result='second selected child', tool='', outcome='', answer='second selected parent',
                 maximum=list(prior['maximum']), admitted=2, lifecycle='completed', resolved=True)
    value.update(deepcopy(changes))
    value.setdefault('usage', [a+b for a,b in zip(prior['usage'], TOOL if value['tool'] else DIRECT)])
    value.setdefault('records', completed_records(value))
    return value


def identity_expression(value):
    return record('Identity', **{key:source_literal(value[key]) for key in ['id','workspace','allowed']})


def expression(value):
    order = ['format','identity','predecessor','predecessor_version','request','task','result','tool','outcome','answer',
             'records','usage','maximum','admitted','lifecycle','resolved']
    assert set(value) == set(order)
    fields = {}
    for key in order:
        item = value[key]
        if key == 'identity': fields[key] = identity_expression(item)
        elif key == 'predecessor': fields[key] = first.expression(item)
        elif key in ['usage','maximum']: fields[key] = ledger(item)
        elif key == 'records':
            fields[key] = '[' + ', '.join('event(' + ', '.join(source_literal(row[name]) for name in
                                         ['role','kind','name','text']) + ')' for row in item) + ']'
        else: fields[key] = source_literal(item)
    return record('Successor', **fields)


def flat(value):
    """Independent successor wire oracle, keeping v1's independent old oracle."""
    allowed = value['identity']['allowed']
    header = ['nomo-harness-successor-v1',value['identity']['id'],value['identity']['workspace'],allowed[0],
              allowed[1] if len(allowed)==2 else '',encoded(first.flat(value['predecessor'])),value['predecessor_version'],
              value['request'],value['task'],value['result'],value['tool'],value['outcome'],value['answer'],
              *map(str,value['usage']),*map(str,value['maximum']),str(value['admitted']),value['lifecycle'],
              'true' if value['resolved'] else 'false',str(len(value['records']))]
    return header + [row[key] for row in value['records'] for key in ['role','kind','name','text']]


def arguments(saved, continuing=True):
    result=['--id',saved['predecessor']['identity']['id'],'--successor',saved['identity']['id'],
            '--workspace',saved['identity']['workspace'],'--allow',','.join(saved['identity']['allowed'])]
    return result+['--once',saved['request']] if continuing else result


def context_sizes(saved):
    prior={key:saved['predecessor'][key] for key in ['task','result','tool','outcome','answer']}
    plan=dict(phase='plan',request=saved['request'],task='',result='',tool='',outcome='',allowed=saved['identity']['allowed'],prior=prior)
    aggregate=dict(phase='aggregate',request=saved['request'],task=saved['task'],result=saved['result'],tool=saved['tool'],
                   outcome=saved['outcome'],allowed=saved['identity']['allowed'],prior=prior)
    child=dict(history=saved['records'][3:10],allowed=saved['identity']['allowed'],final_only=False)
    final=dict(history=saved['records'][3:13],allowed=saved['identity']['allowed'],final_only=True)
    return {key:len(encoded(value)) for key,value in zip(['plan','aggregate','child_first','child_final'],[plan,aggregate,child,final])}


def cases():
    values=[]
    direct=successor()
    def add(label,mode='validate',accepted=True,saved=None,requested=None,predecessor=None,raw='',
            status=0,resolved=True,present=True,mutation='',args=None,help=False):
        saved=deepcopy(direct if saved is None else saved)
        requested=deepcopy(saved['identity'] if requested is None else requested)
        predecessor=deepcopy(saved['predecessor']['identity'] if predecessor is None else predecessor)
        fields=dict(label=source_literal(label),mode=source_literal(mode),saved=expression(saved),
                    requested=identity_expression(requested),predecessor=identity_expression(predecessor),
                    raw=source_literal(raw),accepted=source_literal(accepted),status=str(status),
                    resolved=source_literal(resolved),present=source_literal(present),mutation=source_literal(mutation),
                    args=source_literal([] if args is None else args),help=source_literal(help))
        values.append((label,record('Check',**fields)))
    for old_tool,new_tool in [('', ''),('', 'read'),('read',''),('read','read'),('search','search')]:
        prior=first.checkpoint(tool=old_tool,outcome='complete: OLD' if old_tool else '',usage=list(TOOL if old_tool else DIRECT))
        saved=successor(predecessor=prior,tool=new_tool,outcome='complete: NEW' if new_tool else '')
        name=(old_tool or 'direct')+'_'+(new_tool or 'direct')
        for mode in ['validate','roundtrip','from_turn','restore']:
            add(name+'_'+mode,mode=mode,saved=saved,raw=encoded(flat(saved)) if mode=='roundtrip' else '')
    for label,saved in [
            ('empty_completed',successor(tool='read',outcome='complete: ')),
            ('escaped',successor(request='Q"\\data',task='T"\\data',result='R"\\data',answer='A"\\data')),
            ('spaces',successor(request=' Q ',task=' T ',result=' R ',answer=' A ')),
            ('literal_markers',successor(tool='read',outcome='complete: <LF><LT><TAB>')),
            ('two_allowed',successor(predecessor=first.checkpoint(identity=first.identity(allowed=['docs/a.txt','docs/b.txt']))))]:
        add(label+'_roundtrip',mode='roundtrip',saved=saved,raw=encoded(flat(saved)))
    for field,bad in [('format',0),('format',2),('admitted',1),('admitted',3),('resolved',False),
                       ('lifecycle','pending'),('lifecycle','unresolved'),('request',''),('request','Q'*129),
                       ('request','Q\nR'),('task','T'*129),('result','R'*257),('answer','A'*513),
                       ('predecessor_version',''),('predecessor_version',' '),('predecessor_version','V'*1025),
                       ('predecessor_version','V\n'),('tool','command'),('outcome','complete: unowned')]:
        add('bad_'+field+'_'+str(len(values)),accepted=False,saved=successor(**{field:bad}))
    same=successor(identity=first.identity())
    add('successor_reuses_predecessor_id',accepted=False,saved=same)
    for field,bad in [('id',''),('id','I'*129),('workspace','other'),('allowed',['docs/b.txt'])]:
        saved=successor();saved['identity'][field]=bad
        add('identity_'+field+'_'+str(len(values)),accepted=False,saved=saved)
    for field,bad in [('id','other'),('workspace','other'),('allowed',['docs/b.txt'])]:
        requested=deepcopy(direct['identity']);requested[field]=bad
        add('requested_'+field,accepted=False,requested=requested)
        supplied=deepcopy(direct['predecessor']['identity']);supplied[field]=bad
        add('predecessor_identity_'+field,accepted=False,predecessor=supplied)
    for field,bad in [('admitted',2),('resolved',False),('format',2),('lifecycle','pending'),
                       ('maximum',[13,8,16384,2,8192]),('usage',[0]*5)]:
        saved=successor();saved['predecessor'][field]=bad
        add('invalid_predecessor_'+field,accepted=False,saved=saved)
        add('restore_invalid_'+field,mode='restore',accepted=False,saved=saved)
    for i,key in enumerate(KEYS):
        for owner in ['usage','maximum']:
            saved=successor();saved[owner][i]-=1
            add('incorrect_'+owner+'_'+key,accepted=False,saved=saved)
    add('third_turn_refused',mode='third',accepted=False)
    oversized=first.checkpoint(task='T'*128,result='"'*256,tool='read',outcome='complete: '+'"'*256,
                               answer='"'*512,usage=list(TOOL))
    saved=successor(predecessor=oversized,request='Q'*128)
    add('serialized_prior_context_refused',mode='context',accepted=False,saved=saved)
    add('successor_oversized_prior_context_refused',accepted=False,saved=saved)
    for suffix,answer,expected in [('2048','"'*294,True),('2049','"'*294+'A',False)]:
        prior=first.checkpoint(task='T'*128,result='"'*256,tool='read',outcome='complete: '+'"'*256,
                               answer=answer,usage=list(TOOL))
        saved=successor(predecessor=prior,request='Q'*128)
        assert context_sizes(saved)['plan']==int(suffix)
        add('plan_context_'+suffix,mode='context',accepted=expected,saved=saved)
    for suffix,result,expected in [('2048','"'*227+'A',True),('2049','"'*227+'AB',False)]:
        prior=first.checkpoint(task='T'*128,result='R'*256,tool='read',outcome='complete: '+'O'*256,
                               answer='A'*512,usage=list(TOOL))
        saved=successor(predecessor=prior,request='Q'*128,task='T'*128,result=result)
        sizes=context_sizes(saved);assert sizes['aggregate']==int(suffix) and sizes['child_first']<=2048 and sizes['plan']<=2048
        add('aggregate_context_'+suffix,accepted=expected,saved=saved)
    for suffix,length,expected in [('2048',156,True),('2049',157,False)]:
        prior=first.checkpoint(task='T'*100,result='R'*200,tool='read',outcome='complete: '+'O'*200,
                               answer='A'*length,usage=list(TOOL))
        saved=successor(predecessor=prior,request='Q'*100,task='T'*100,result='R',tool='read',outcome='complete: '+'"'*256)
        sizes=context_sizes(saved);assert sizes['child_final']==int(suffix) and max(sizes[key] for key in ['plan','aggregate','child_first'])<=2048
        add('second_child_context_'+suffix,accepted=expected,saved=saved)
    for index in range(14):
        saved=successor();saved['records'][index]['text']='forged'
        # Empty model text and all original/prior/planning/selected records are bound.
        add('record_text_'+str(index),accepted=False,saved=saved)
    for label,mutate in [
            ('drop',lambda rows:rows.pop()),('duplicate',lambda rows:rows.append(deepcopy(rows[-1]))),
            ('reorder',lambda rows:rows.reverse()),('model_identity',lambda rows:rows[10].update(name='other')),
            ('prior_role',lambda rows:rows[5].update(role='assistant'))]:
        saved=successor();mutate(saved['records']);add('records_'+label,accepted=False,saved=saved)
    tool=successor(tool='read',outcome='complete: NEW')
    for index,field,bad in [(11,'text','["read","docs/b.txt"]'),(11,'name','search'),(12,'kind','error'),
                             (12,'text','complete: forged'),(13,'role','assistant'),(16,'name','search')]:
        saved=deepcopy(tool);saved['records'][index][field]=bad
        add('tool_record_'+str(index)+'_'+field,accepted=False,saved=saved)
    for status,resolved,present in [(1,True,True),(0,False,True),(0,True,False)]:
        add('receipt_'+str(status)+str(resolved)+str(present),mode='from_turn',accepted=False,
            status=status,resolved=resolved,present=present)
    for mutation in ['prior','usage','maximum','admitted']:
        add('receipt_changed_'+mutation,mode='from_turn',accepted=False,mutation=mutation)
    raw=encoded(flat(direct));assert len(flat(direct))==83 and len(flat(tool))==99
    version=successor(predecessor_version='V'*1024)
    add('maximum_opaque_version',mode='roundtrip',saved=version,raw=encoded(flat(version)))
    fields=flat(direct);fields[5]+=' '*(65536-len(fields[5]))
    add('decode_nested_field_65536',mode='decode',raw=encoded(fields))
    for size in [196608,196609]:
        add('decode_raw_'+str(size),mode='decode',accepted=size==196608,raw=raw+' '*(size-len(raw)))
    add('decode_101_fields',mode='decode',accepted=False,raw=encoded(flat(tool)+['extra']*2))
    for label,index,bad in [('old_v1',0,'nomo-harness-checkpoint-v1'),('unknown_version',0,'nomo-harness-successor-v2'),
                          ('nested_unknown',5,'[]'),('nested_oversized',5,' '*65537),('version_oversized',6,'V'*1025),
                          ('leading_zero',13,'010'),('overflow',13,'2147483648'),('negative',13,'-1'),
                          ('not_two',23,'1'),('not_completed',24,'pending'),('not_true',25,'TRUE'),
                          ('bad_count',26,'18'),('leading_count',26,'014')]:
        fields=flat(direct);fields[index]=bad
        add('decode_'+label,mode='decode',accepted=False,raw=encoded(fields))
    for label,bad in [('empty',''),('object','{}'),('nested','['*1000+'"x"'+']'*1000),
                      ('trailing',raw+'true'),('multibyte',raw.replace('second question','second é question'))]:
        add('decode_'+label,mode='decode',accepted=False,raw=bad)
    for continuing in [True,False]:
        mode='continue_args' if continuing else 'show_args'
        valid=arguments(direct,continuing)
        add(mode,mode=mode,args=valid)
        add(mode+'_help',mode=mode,args=['--help'],help=True)
        for label,args in [('empty',[]),('missing',valid[:-1]),('unknown',['--unknown',*valid[1:]]),
                           ('duplicate',['--id','checkpoint-1','--id','successor-1',*valid[4:]]),
                           ('same_id',['--id','checkpoint-1','--successor','checkpoint-1',*valid[4:]]),
                           ('too_many',valid+['extra']),('allow_large',[*valid[:7],'a'*98,*valid[8:]])]:
            add(mode+'_'+label,mode=mode,accepted=False,args=args)
    literal=successor(request='--help')
    add('literal_once_help',mode='continue_args',saved=literal,args=arguments(literal))
    assert 0<len(values)<=256 and len(values)==len({label for label,_ in values})
    return values


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
BATCH_SIZE=16
MANIFEST=first.MANIFEST.replace('harness-checkpoint-contract-probe','harness-successor-contract-probe')
def batches(values):
    assert len(values)==len({label for label,_ in values})
    return [(offset,values[offset:offset+BATCH_SIZE]) for offset in range(0,len(values),BATCH_SIZE)]
def generated(template,values):
    assert template.count('__CHECKS__')==1
    return template.replace('__CHECKS__','['+',\n'.join(body for _,body in values)+']')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--etas',required=True,type=Path)
    parser.add_argument('--evidence-dir',required=True,type=Path)
    parser.add_argument('--prepare-only',action='store_true')
    args=parser.parse_args();assert args.etas.is_absolute()
    cli=args.etas if args.prepare_only else verify_cli()
    assert args.prepare_only or cli.resolve()==args.etas.resolve()
    evidence=Path(tempfile.mkdtemp(prefix='harness-successor-contract-',dir=args.evidence_dir))
    print('EVIDENCE '+str(evidence),flush=True)
    paths=[ROOT/'src/nomo'/name for name in MODULES]+[Path(__file__).resolve(),FIXTURE,
           ROOT/'tests/harness_checkpoint_contract_probe.py',ROOT/'tests/normal_graph_identity.py',
           bootstrap_path(),ROOT/'config/etas-latest-main.json',ROOT/'etas.lock']
    frozen={str(p.relative_to(ROOT)):digest(p) for p in paths}
    for source in paths:
        target=evidence/'inputs'/source.relative_to(ROOT);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        assert digest(target)==frozen[str(source.relative_to(ROOT))]
    values=cases();groups=batches(values);template=(evidence/'inputs'/FIXTURE.relative_to(ROOT)).read_text()
    result=dict(scope='synthetic pure successor contracts; no actual Model/File/Memory claim',
                status='prepared' if args.prepare_only else 'running',prepared_only=args.prepare_only,
                checks=[label for label,_ in values],inputs=frozen,batches=[],commands=[],observed_checks=[],
                root_lock_provenance_only=True,case_matrix_sha256=hashlib.sha256(encoded(values).encode()).hexdigest(),
                batch_size=BATCH_SIZE,per_command_timeout_seconds=180,
                codec_bounds=dict(raw=196608,string_fields=100,predecessor_field=65536,other_field=1024,
                                  aggregate_decoded=73728,valid_arities=[83,99],maximum=list(DEFAULT)))
    for index,(offset,group) in enumerate(groups):
        directory=evidence/'batches'/f'{index:03d}';project=directory/'project'
        for name in MODULES:
            target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(evidence/'inputs/src/nomo'/name,target)
        source=project/'src/app/contract_probe.es';source.parent.mkdir(parents=True)
        source.write_text(generated(template,group));(project/'etas.toml').write_text(MANIFEST)
        result['batches'].append(dict(index=index,offset=offset,checks=[label for label,_ in group],
            project=str(project.relative_to(evidence)),generated_source_sha256=digest(source),
            status='prepared' if args.prepare_only else 'not_run',command_indices=[]))
    output=evidence/'results.json'
    def save(): output.write_text(json.dumps(result,indent=2)+'\n')
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
                item=dict(label=f'batch-{batch["index"]:03d}-'+name,kind=name,batch=batch['index'],project=batch['project'],
                          status='running',command=[str(cli),*arguments],inputs={str(p.relative_to(project)):digest(p) for p in inputs})
                batch['command_indices'].append(len(result['commands']));result['commands'].append(item);save()
                try:run=subprocess.run(item['command'],capture_output=True,timeout=180)
                except subprocess.TimeoutExpired as error:
                    for label,raw in [('stdout',error.stdout or b''),('stderr',error.stderr or b'')]:
                        path=directory/(name+'.'+label+'.bin');path.write_bytes(raw)
                        item[label+'_sha256']=digest(path);item[label+'_retained']=str(path.relative_to(evidence))
                    item.update(timeout=True,exit=None);save();raise
                for label,raw in [('stdout',run.stdout),('stderr',run.stderr)]:
                    path=directory/(name+'.'+label+'.bin');path.write_bytes(raw)
                    item[label+'_sha256']=digest(path);item[label+'_retained']=str(path.relative_to(evidence))
                item.update(exit=run.returncode,timeout=False,stdout=run.stdout.decode(),stderr=run.stderr.decode());save()
                assert run.returncode==0 and not run.stderr,item
                assert all(digest(project/p)==h for p,h in item['inputs'].items()),'project input drift'
                if name=='pure-effects':assert 'requested actions: []' in item['stdout'] and 'default actions: []' in item['stdout']
                if name=='observe':
                    assert item['stdout'].splitlines()==['PASS '+label for label in batch['checks']]
                    trace=json.loads(trace_path.read_text());starts=[e for e in trace['events'] if e['kind']=='host_request_started']
                    assert {e['qualified_action'] for e in starts}<={'Policy.evaluate','Console.stdout_write'}
                    assert sum(e['qualified_action']=='Console.stdout_write' for e in starts)==len(batch['checks'])
                    batch.update(trace_sha256=digest(trace_path),trace_retained=str(trace_path.relative_to(evidence)))
                    result['observed_checks'].extend(line[len('PASS '):] for line in item['stdout'].splitlines())
                item['status']='passed';save()
            batch['status']='passed';save()
        assert result['observed_checks']==result['checks'] and len(set(result['observed_checks']))==len(values)
        assert len(result['commands'])==3*len(groups) and all(b['status']=='passed' for b in result['batches'])
        assert {str(p.relative_to(ROOT)):digest(p) for p in paths}==frozen and digest(cli)==result['identity']['sha256']
        result.update(status='passed',inputs_unchanged=True);save()
        print('PASS '+str(len(values))+' pure successor checks in '+str(len(groups))+' serial batches; synthetic contracts only',flush=True)
    except BaseException as error:
        if 'item' in locals() and item['status']!='passed':item['status']='failed'
        if 'batch' in locals() and batch['status']!='passed':batch['status']='failed'
        result.update(status='failed',failure=repr(error));save();raise


if __name__=='__main__': main()
