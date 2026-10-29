#!/usr/bin/env python3
"""Read-only discovery controller qualification with deterministic source handlers."""
import argparse, hashlib, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import literal, resources
from normal_graph_identity import verify_cli
ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/discovery_interface001/controller_probe.es'
CHANGE='v2 discovery changed during repeated reads; no selection or continuation'
MISMATCH='v2 discovery selected row differs from inspect authority'
PARENT='v2 discovered parent changed before continuation'
ELIG='latest continuation requires a confirmed first turn and unused second slot; no fallback or replay'

def cases():
    items=[]
    def add(label,method,kind='confirmed',selector='all',authority='',fail=0,drift=0,diff='',workspace='owned',error='',tape=None):
        args=[label,kind]
        if method=='discover':args += [selector]
        args += [authority,fail,drift,diff,workspace,error]
        expr=method+'_case('+', '.join(map(literal,args))+')'
        items.append((label,expr,tape or []))
    def cap(n):return [f'capture {i} '+('first' if i%2 else 'recheck') for i in range(1,n+1)]
    def tape(authority, n=4):return cap(min(n,2))+authority+(cap(n)[2:] if n>2 else [])
    add('empty_all','discover','empty',tape=tape([]))
    add('empty_latest','discover','empty',selector='latest',tape=tape([]))
    add('two_all','discover','child_confirmed',tape=tape(['inspect root-op','inspect child-op']))
    add('latest_child','discover','child_confirmed',selector='latest',tape=tape(['inspect child-op']))
    add('exact_root','discover','child_confirmed',selector='root-op',tape=tape(['inspect root-op']))
    add('exact_child','discover','child_confirmed',selector='child-op',tape=tape(['inspect child-op']))
    add('confirmed_parent_selector','discover',selector='parent',tape=tape(['inspect root-op']))
    add('parent_ok','parent',tape=tape(['parent root-op']))
    add('no_parent_empty','parent','empty',error=ELIG,tape=cap(2))
    add('no_parent_with_child','parent','child_confirmed',error=ELIG,tape=cap(2))
    add('unknown_exact','discover',selector='missing-id',error='v2 discovery selected ID missing',tape=cap(2))
    for method in ['discover','parent']:
        add(method+'_invalid_binding',method,workspace='',error='invalid edit operation identity',tape=[])
        for i in range(1,5):
            prefix=cap(i) if i<=2 else tape(['inspect root-op'] if method=='discover' else ['parent root-op'],i)
            add(method+'_capture_failure_'+str(i),method,fail=i,error='capture refused',tape=prefix)
            add(method+'_capture_drift_'+str(i),method,drift=i,diff='root_version',error=CHANGE,tape=cap(2) if i<=2 else tape(['inspect root-op'] if method=='discover' else ['parent root-op']))
        for mode in ['error','row']:
            reason=('inspect refused' if method=='discover' else 'parent refused') if mode=='error' else (MISMATCH if method=='discover' else PARENT)
            add(method+'_authority_'+mode,method,authority=mode,error=reason,tape=cap(2)+(['inspect root-op'] if method=='discover' else ['parent root-op']))
    add('inspect_missing','discover',authority='missing',error=MISMATCH,tape=cap(2)+['inspect root-op'])
    add('second_inspect_error','discover','child_confirmed',authority='second_error',error='inspect refused',tape=cap(2)+['inspect root-op','inspect child-op'])
    add('second_inspect_row','discover','child_confirmed',authority='second_row',error=MISMATCH,tape=cap(2)+['inspect root-op','inspect child-op'])
    for mode in ['key','version']:
        add('parent_'+mode,'parent',authority=mode,error=PARENT,tape=cap(2)+['parent root-op'])
    for diff in ['root_key','root_value','root_version','child_key','child_value','child_version','lineage','journal_version','journal_phase','child_journal_version','child_journal_chain','root_absent','child_absent','journal_absent','child_journal_absent']:
        add('complete_snapshot_'+diff,'discover','child_confirmed',drift=4,diff=diff,error=CHANGE,tape=tape(['inspect root-op','inspect child-op']))
    return items

def row_set(value):
    assert value.startswith('[') and value.endswith(']')
    parts=re.findall(r'[A-Za-z_][A-Za-z0-9_.]*(?:<[^<>]+>|\[[^\[\]]+\])?',value[1:-1])
    assert value=='['+', '.join(parts)+']' and len(parts)==len(set(parts))
    return set(parts)

def audit_effects(report):
    assert report['command']=='effects' and not report['diagnostics']
    items=report['items'];result={}
    def one(name,handled=None):
        found=[x for x in items if x['name']==name and x['kind']=='flow']
        if handled is not None: found=[x for x in found if ('SessionObservation.capture' not in row_set(x['escaping_effects'])) == handled and 'SessionObservation.capture' in row_set(x['requested_actions'])]
        assert len(found)==1,(name,len(found))
        x=found[0];assert 'rejected' not in x['support'].lower() and not any('Unresolved' in v for v in x['residual_checks'])
        rows={k:row_set(x[k]) for k in ['escaping_effects','requested_actions','default_actions']};result[name]={'rows':{k:sorted(v) for k,v in rows.items()},'support':x['support']};return rows
    capture='SessionObservation.capture';inspect='DiscoveryAuthority.inspect';parent='DiscoveryAuthority.confirmed_parent'
    for name,expected in [('discovery_unhandled',{capture,inspect}),('latest_unhandled',{capture,parent})]:
        row=one(name);assert expected <= row['requested_actions'] and expected <= row['escaping_effects'] and not row['default_actions'],name
    row=one('exercise');assert {capture,inspect,parent} <= row['requested_actions'] and not {capture,inspect,parent}&row['escaping_effects']
    assert row['default_actions']=={'Console.stdout_write'} and not any(x.startswith(('Memory.','Fs.','Model.','Agentic.','Approval.','Command.')) for x in row['requested_actions'])
    memory={'Memory.read[nomo.session.work_chain_journal.Journal.Rows]','Memory.read[nomo.session.work_chain_store.Chain.Rows]'}
    for name,required in [('discover',{capture,inspect}),('latest_parent',{capture,parent}),('run_sessions',{capture,inspect}),('run_show',{capture,inspect})]:
        row=one(name,True);assert required <= row['requested_actions'] and not required&row['escaping_effects'] and memory <= row['requested_actions'],name
        assert not any(x.startswith('Memory.write') for x in row['requested_actions']),name
    for name in ['capture_adapter','inspect_adapter','confirmed_parent_adapter']:
        row=one(name);assert memory <= row['requested_actions'] and not any(x.startswith('Memory.write') for x in row['requested_actions']),name
    # Terminal run owns real write-capable workflows; latest remains reachable through the facade.
    row=one('selected_config');assert {capture,parent} <= row['requested_actions'] and not {capture,parent}&row['escaping_effects'] and memory <= row['requested_actions']
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--evidence-dir',type=Path,required=True);p.add_argument('--prepare-only',action='store_true');args=p.parse_args()
    args.evidence_dir.mkdir(parents=True,exist_ok=True);e=Path(tempfile.mkdtemp(prefix='discovery-interface-',dir=args.evidence_dir));project=e/'project';(project/'src/app').mkdir(parents=True)
    print('EVIDENCE '+str(e),flush=True);items=cases();sources={}
    for src in sorted((ROOT/'src/nomo').rglob('*.es')):
        dst=project/'src'/src.relative_to(ROOT/'src');dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);sources[str(src.relative_to(ROOT))]=hashlib.sha256(src.read_bytes()).hexdigest()
    generated=FIXTURE.read_text().replace('__CHECKS__',',\n'.join('Check { label = '+literal(label)+', passed = '+expr+' }' for label,expr,_ in items))
    (project/'src/app/discovery_interface_probe.es').write_text(generated);(project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','discovery-interface-probe').replace('app.contract_probe','app.discovery_interface_probe').replace('flow = "observe"','flow = "exercise"'))
    for name in ['wrong_input','wrong_output','extra_error']:
        neg=e/name;shutil.copytree(project,neg);(neg/'src/app/discovery_interface_probe.es').unlink();shutil.copyfile(FIXTURE.parent/(name+'.es'),neg/'src/app/callable_negative.es');manifest=neg/'etas.toml';manifest.write_text(manifest.read_text().replace('app.discovery_interface_probe','app.callable_negative').replace('flow = "exercise"','flow = "observe"'))
    record={'status':'prepared','cases':[x[0] for x in items],'sources':sources,'commands':[],'qualification':'Copied observations and deterministic source handlers; no native storage/receipt, business Model, File, Memory, Approval, Command or SSH execution.'}
    out=e/'results.json'
    def save():out.write_text(json.dumps(record,indent=2)+'\n')
    save()
    if args.prepare_only:return
    try:
        cli=str(verify_cli());count=len(list((project/'src').rglob('*.es')))
        commands=[('check',[cli,'check','--all',str(project)]),('effects',[cli,'--format','json','effects',str(project)]),('exercise',[cli,'run',str(project),'--flow','exercise','--allow-effects','--budget-time','40s','--trace-out',str(e/'exercise.trace.json')])]
        env={name:os.environ[name] for name in ['PATH','HOME','LANG','CARGO_HOME','CARGO_TARGET_DIR'] if name in os.environ};env.update(NOMO_NORMAL_GRAPH='latest',ETAS_HOST_FILESYSTEM='none',ETAS_HOST_MEMORY='none',ETAS_HOST_SESSION='none',ETAS_HOST_APPROVAL='deny')
        for label,argv in commands:
            argv.insert(1,'--no-config')
            item={'label':label,'command':argv};record['commands'].append(item);save();r=subprocess.run(argv,capture_output=True,input=b'',env=env,timeout=240)
            (e/(label+'.stdout.bin')).write_bytes(r.stdout);(e/(label+'.stderr.bin')).write_bytes(r.stderr)
            item.update(exit=r.returncode,stdout=r.stdout.decode(),stderr=r.stderr.decode());save()
            assert r.returncode==0 and not r.stderr,(label,str(e))
            if label=='check':assert item['stdout']=='checked '+str(count)+' files\n'
            if label=='exercise':
                expected=[]
                for name,_,tape in items:expected.extend('PORT '+name+' '+x for x in tape)
                expected.extend('PASS '+name for name,_,_ in items)
                assert item['stdout']=='\n'.join(expected)+'\n',(label,'tape or result mismatch',str(e))
                trace=json.loads((e/'exercise.trace.json').read_text());events=trace['events'];assert trace['schema']=='etas.cli.interpreter-report.v1' and not trace.get('incomplete',False) and trace['outcome']['kind']=='completed' and trace['termination']['local_work_settled'] is True
                starts=[v for v in events if v['kind']=='host_request_started'];ends=[v for v in events if v['kind']=='host_request_finished'];ids=[v['id'] for v in starts];end_ids=[v['id'] for v in ends]
                assert len(ids)==len(set(ids))==len(end_ids)==len(set(end_ids)) and set(ids)==set(end_ids)
                assert all(v['outcome']['kind']=='succeeded' for v in ends) and all(v['qualified_action'] in ['Policy.evaluate','Console.stdout_write'] for v in starts)
                assert sum(v['qualified_action']=='Console.stdout_write' for v in starts)==len(expected)
                record['trace']={'confirmed_paired_host_requests':len(ids),'console_writes':len(expected),'business_host_operations':0};save()
            if label=='effects':
                data=json.loads(item['stdout']);record['effects']=audit_effects(data);save()
        for name,code,message in [('wrong_input','type::TypeMismatch','implementation input type does not satisfy the callable spec'),('wrong_output','type::TypeMismatch','implementation output type does not satisfy the callable spec'),('extra_error','effect::EffectOutsideDeclaredRow','implementation escaping effects do not satisfy the callable spec bound')]:
            neg=e/name;argv=[cli,'--no-config','--format','json','check','--all',str(neg)];item={'label':name,'command':argv};record['commands'].append(item);save();r=subprocess.run(argv,capture_output=True,input=b'',env=env,timeout=240)
            (e/(name+'.stdout.bin')).write_bytes(r.stdout);(e/(name+'.stderr.bin')).write_bytes(r.stderr);item.update(exit=r.returncode,stdout=r.stdout.decode(),stderr=r.stderr.decode());save()
            assert r.returncode!=0 and not r.stderr;report=json.loads(item['stdout']);diagnostics=[(Path(f['path']).resolve(),d) for f in report['files'] for d in f['diagnostics']];assert len(diagnostics)==1,(name,diagnostics)
            path,d=diagnostics[0];source=neg/'src/app/callable_negative.es';line=next(i for i,x in enumerate(source.read_text().splitlines(),1) if x.startswith('flow bad('))
            assert path==source.resolve() and d['severity']=='error' and d['code']==code and d['message']==message and d['primary']['span']['startLine']==line,(name,d)
        record['status']='passed'
    except BaseException as err:record.update(status='failed',failure=repr(err));raise
    finally:
        record['resources'],valid=resources()
        if not valid:record.update(status='failed',resource_failure='ordinary 4GiB resource guard')
        save();assert valid,str(e)
    print('PASS '+str(len(items))+' discovery controller cases',flush=True)
if __name__=='__main__':main()
