#!/usr/bin/env python3
"""D9 shared preparation with deterministic source handlers; no business Host."""
import argparse, hashlib, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import resources
from normal_graph_identity import verify_cli
ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/harness_prepare_interface001'

def row_set(value):
    assert value.startswith('[') and value.endswith(']')
    parts=re.findall(r'[A-Za-z_][A-Za-z0-9_.]*(?:<[^<>]+>|\[[^\[\]]+\])?',value[1:-1])
    assert value=='['+', '.join(parts)+']' and len(parts)==len(set(parts))
    return set(parts)

def audit(report):
    assert report['command']=='effects' and not report['diagnostics'];result={}
    def selected(name,handled=None):
        found=[x for x in report['items'] if x['name']==name and x['kind']=='flow']
        if handled is not None:
            found=[x for x in found if 'EditOriginal.read' in row_set(x['requested_actions']) and ('EditOriginal.read' not in row_set(x['escaping_effects']))==handled]
        assert len(found)==1,(name,len(found));x=found[0]
        assert 'rejected' not in x['support'].lower() and not any('Unresolved' in v for v in x['residual_checks'])
        rows={k:row_set(x[k]) for k in ['escaping_effects','requested_actions','default_actions']};result[name]={'rows':{k:sorted(v) for k,v in rows.items()},'support':x['support']};return rows
    fs={'Fs.stat[nomo.tools.edit_file.EditableRoot]','Fs.read[nomo.tools.edit_file.EditableRoot]'}
    reader=selected('read_original');assert fs <= reader['requested_actions'] and fs <= reader['default_actions'] and not fs & reader['escaping_effects']
    assert {'Error<std.fs.IOError>','Error<std.runtime.error.IndexError>'} <= reader['escaping_effects']
    source=selected('prepare_with');assert 'EditOriginal.read' in source['requested_actions'] and 'EditOriginal.read' in source['escaping_effects']
    assert {'LegacyStringStages.main','LegacyStringStages.child','LegacyEditStages.plan','LegacyEditStages.child'} <= source['escaping_effects']
    prod=selected('prepare',True);assert fs <= prod['requested_actions'] and 'EditOriginal.read' not in prod['escaping_effects']
    assert {'LegacyStringStages.main','LegacyStringStages.child','LegacyEditStages.plan','LegacyEditStages.child'} <= prod['escaping_effects']
    for name in ['prepare_work','prepare_chain_work','run_save']:
        row=selected(name,True);assert fs <= row['requested_actions'] and not {'EditOriginal.read','LegacyStringStages.main','LegacyStringStages.child','LegacyEditStages.plan','LegacyEditStages.child'}&row['escaping_effects'],name
        assert any(x.startswith('Agentic.infer[') for x in row['requested_actions']),name
    observe=selected('observe',True);assert 'EditOriginal.read' in observe['requested_actions'] and 'EditOriginal.read' not in observe['escaping_effects']
    assert not any(x.startswith(('Memory.','Fs.','Model.','Agentic.','Approval.','Command.')) for x in observe['requested_actions'])
    assert observe['default_actions']=={'Console.stdout_write'}
    return result

def host_trace(path,completed):
    t=json.loads(path.read_text());assert t['schema']=='etas.cli.interpreter-report.v1' and not t.get('incomplete',False) and t['outcome']['kind']==('completed' if completed else 'failed') and t['termination']['local_work_settled'] is True
    starts=[v for v in t['events'] if v['kind']=='host_request_started'];ends=[v for v in t['events'] if v['kind']=='host_request_finished'];a=[v['id'] for v in starts];b=[v['id'] for v in ends]
    assert len(a)==len(set(a))==len(b)==len(set(b)) and set(a)==set(b) and all(v['outcome']['kind']=='succeeded' for v in ends)
    assert all(v['qualified_action'] in ['Policy.evaluate','Console.stdout_write'] for v in starts)
    return {'confirmed_paired_host_requests':len(a),'console_writes':sum(v['qualified_action']=='Console.stdout_write' for v in starts),'business_host_operations':0}

def tape(label,stage):
    read=['read-main plan','read-child','read-main aggregate','read-original dir/file.txt']
    if stage=='full':read+=['stage edit-plan','edit-plan','stage edit-child','edit-child']
    elif stage=='bad_plan':read=['read-main plan']
    elif stage=='bad_child':read=['read-main plan','read-child']
    return ['PORT '+label+' '+x for x in read]

def main():
    p=argparse.ArgumentParser();p.add_argument('--evidence-dir',type=Path,required=True);p.add_argument('--prepare-only',action='store_true');args=p.parse_args();args.evidence_dir.mkdir(parents=True,exist_ok=True)
    e=Path(tempfile.mkdtemp(prefix='harness-prepare-interface-',dir=args.evidence_dir));project=e/'project';(project/'src/app').mkdir(parents=True);print('EVIDENCE '+str(e),flush=True)
    sources={}
    for src in sorted((ROOT/'src/nomo').rglob('*.es')):
        dst=project/'src'/src.relative_to(ROOT/'src');dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);sources[str(src.relative_to(ROOT))]=hashlib.sha256(src.read_bytes()).hexdigest()
    shutil.copyfile(FIXTURE/'controller_probe.es',project/'src/app/prepare_interface_probe.es')
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','harness-prepare-interface').replace('app.contract_probe','app.prepare_interface_probe'))
    for name in ['wrong_input','wrong_output','extra_error']:
        neg=e/name;shutil.copytree(project,neg);(neg/'src/app/prepare_interface_probe.es').unlink();shutil.copyfile(FIXTURE/(name+'.es'),neg/'src/app/callable_negative.es');manifest=neg/'etas.toml';manifest.write_text(manifest.read_text().replace('app.prepare_interface_probe','app.callable_negative'))
    record={'status':'prepared','sources':sources,'commands':[],'qualification':'Same application controller with source test handlers; no business Model, Fs, Memory, Approval, Command or SSH; source abort is not a native file exception.'}
    out=e/'results.json'
    def save():out.write_text(json.dumps(record,indent=2)+'\n')
    save()
    if args.prepare_only:return
    try:
        cli=str(verify_cli());count=len(list((project/'src').rglob('*.es')));env={name:os.environ[name] for name in ['PATH','HOME','LANG','CARGO_HOME','CARGO_TARGET_DIR'] if name in os.environ};env.update(NOMO_NORMAL_GRAPH='latest',ETAS_HOST_FILESYSTEM='none',ETAS_HOST_MEMORY='none',ETAS_HOST_SESSION='none',ETAS_HOST_APPROVAL='deny')
        def invoke(label,argv):
            command=[cli,'--no-config',*map(str,argv)];item={'label':label,'command':command};record['commands'].append(item);save();r=subprocess.run(command,capture_output=True,input=b'',env=env,timeout=240)
            (e/(label+'.stdout.bin')).write_bytes(r.stdout);(e/(label+'.stderr.bin')).write_bytes(r.stderr);item.update(exit=r.returncode,stdout=r.stdout.decode(),stderr=r.stderr.decode());save();return item
        item=invoke('check',['check','--all',project]);assert item['exit']==0 and not item['stderr'] and item['stdout']=='checked '+str(count)+' files\n'
        item=invoke('effects',['--format','json','effects',project]);assert item['exit']==0 and not item['stderr'];record['effects']=audit(json.loads(item['stdout']));save()
        item=invoke('observe',['run',project,'--flow','observe','--allow-effects','--budget-time','40s','--trace-out',e/'observe.trace.json']);assert item['exit']==0 and not item['stderr']
        expected=[]
        for label,stage in [('legacy','full'),('chain','full'),('read_error','read'),('mismatch','read'),('bad_plan','bad_plan'),('bad_child','bad_child')]:expected+=tape(label,stage)+['PASS '+label]
        actual=[line for line in item['stdout'].splitlines() if line.startswith(('PORT ','PASS ','FAIL '))];assert actual==expected,(actual,expected)
        record['trace']=host_trace(e/'observe.trace.json',True);save()
        item=invoke('abort',['run',project,'--flow','abort_probe','--allow-effects','--budget-time','20s','--trace-out',e/'abort.trace.json']);assert item['exit']!=0 and 'D9_EXPECTED_READ_ABORT' in item['stdout']+item['stderr'] and 'UNREACHABLE' not in item['stdout']+item['stderr']
        assert [x for x in item['stdout'].splitlines() if x.startswith('PORT ')]==tape('abort','read')
        record['abort_trace']=host_trace(e/'abort.trace.json',False);save()
        for name,code,message in [('wrong_input','type::TypeMismatch','implementation input type does not satisfy the callable spec'),('wrong_output','type::TypeMismatch','implementation output type does not satisfy the callable spec'),('extra_error','effect::EffectOutsideDeclaredRow','implementation escaping effects do not satisfy the callable spec bound')]:
            neg=e/name;item=invoke(name,['--format','json','check','--all',neg]);assert item['exit']!=0 and not item['stderr'];report=json.loads(item['stdout']);diags=[(Path(f['path']).resolve(),d) for f in report['files'] for d in f['diagnostics']];assert len(diags)==1,(name,diags)
            path,d=diags[0];source=neg/'src/app/callable_negative.es';line=next(i for i,x in enumerate(source.read_text().splitlines(),1) if x.startswith('flow bad('));assert path==source.resolve() and d['severity']=='error' and d['code']==code and d['message']==message and d['primary']['span']['startLine']==line,(name,d)
        record['status']='passed'
    except BaseException as err:record.update(status='failed',failure=repr(err));raise
    finally:
        record['resources'],valid=resources()
        if not valid:record.update(status='failed',resource_failure='ordinary 4GiB guard')
        save();assert valid,str(e)
    print('PASS D9 6 prepare cases, abort, effects and callable negatives',flush=True)
if __name__=='__main__':main()
