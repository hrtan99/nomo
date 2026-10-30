#!/usr/bin/env python3
"""D12 same read controller with collected and production progress sinks."""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path
from harness_checkpoint_contract_probe import MANIFEST, source_literal
from model_protocol_probe import resources
from normal_graph_identity import verify_cli
ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/harness_progress001'

class Source(str):pass
def val(v):return v if isinstance(v,Source) else source_literal(v)
def record(name,d):return name+' { '+', '.join(k+' = '+str(val(v)) for k,v in d.items())+' }'
PLAN='["delegate","T"]'
SECRET='["delegate","lab-qwen-T"]'
def cases():
    values = [
      dict(label='success',mode='success',plan=PLAN,answer='Answer',inspect_plan=False,inspect_all=False,expected='Ok(expected_report("Answer"))'),
      dict(label='bad_plan',mode='bad_plan',plan='broken',answer='Answer',inspect_plan=False,inspect_all=False,expected='expected_failure(1, 1, 0, "expected bounded flat single-line delegation JSON", true)'),
      dict(label='unresolved',mode='unresolved',plan=PLAN,answer='Answer',inspect_plan=False,inspect_all=False,expected='expected_failure(2, 1, 0, "child original request or task history changed", false)'),
      dict(label='child_failure',mode='child_failure',plan=PLAN,answer='Answer',inspect_plan=False,inspect_all=False,expected='expected_failure(3, 2, 0, "child returned failure; no aggregation", true)'),
      dict(label='inspect_plan_redacted',mode='inspect_plan_redacted',plan=SECRET,answer='Answer',inspect_plan=True,inspect_all=False,expected='expected_failure(1, 1, 0, "read-plan inspection complete; no child, File or edit attempted", true)'),
      dict(label='inspect_plan_limit',mode='inspect_plan_limit',plan='x'*385,answer='Answer',inspect_plan=True,inspect_all=False,expected='expected_failure(1, 1, 0, "expected bounded flat single-line delegation JSON", true)'),
      dict(label='inspect_all',mode='inspect_all',plan=PLAN,answer='Answer',inspect_plan=False,inspect_all=True,expected='Ok(expected_report("Answer"))'),
      dict(label='inspect_all_redacted',mode='inspect_all_redacted',plan=PLAN,answer='Bearer X',inspect_plan=False,inspect_all=True,expected='Ok(expected_report("Bearer X"))'),
      dict(label='invalid_request',mode='invalid_request',request='',allowed=['a.txt'],plan=PLAN,answer='Answer',inspect_plan=False,inspect_all=False,expected='expected_failure(0, 0, 0, "question requires 1..128 printable ASCII chars, not only spaces", true)'),
      dict(label='invalid_allowed',mode='invalid_allowed',request='Q',allowed=[],plan=PLAN,answer='Answer',inspect_plan=False,inspect_all=False,expected='expected_failure(0, 0, 0, "expected one or two allowed files", true)'),
    ]
    for item in values:
        item.setdefault('request','Q');item.setdefault('allowed',['a.txt'])
    return values
def source_case(c):return record('Case',{k:(Source(v) if k=='expected' else v) for k,v in c.items()})
def numbers(steps,calls,tools):return f'steps={steps} calls={calls} tokens={calls*2048} tools={tools} scan={tools*4096}'
def stage(phase,steps,calls,tools):
    rs={'plan':6,'child':5,'aggregate':0}[phase];rc=0 if phase=='aggregate' else 3;rt=0 if phase=='aggregate' else 1
    line=f'STAGE fixture-{phase} child-1 {numbers(steps,calls,tools)} reserved_steps={rs} reserved_calls={rc} reserved_tokens={rc*2048} reserved_tools={rt} reserved_scan={rt*4096}'
    return [line]+(['RESERVATION child-1 steps=3 calls=2 tokens=4096 tools=1 scan=4096 tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true'] if phase=='child' else [])
def diag(phase,text,redacted=False,clipped=False):
    return f'phase={phase} returned-text clipped={str(clipped).lower()} redacted={str(redacted).lower()} text='+json.dumps([text],ensure_ascii=True,separators=(',',':'))
def progress(case):
    if case['mode'] in ['invalid_request','invalid_allowed']:return []
    p=[('progress',x) for x in stage('plan',1,1,0)]+[('port','PORT main plan')]
    if case['inspect_plan']:
        p.append(('progress',diag('read-plan','<redacted>' if case['mode']=='inspect_plan_redacted' else '<omitted:raw-limit>',case['mode']=='inspect_plan_redacted',case['mode']=='inspect_plan_limit')))
    elif case['inspect_all']:p.append(('progress',diag('read-plan',case['plan'])))
    if case['mode'] in ['bad_plan','inspect_plan_redacted','inspect_plan_limit']:return p
    p += [('progress','EVENT main -> child-1 request child-1: T')]+[('progress',x) for x in stage('child',2,1,0)]+[('port','PORT child')]
    if case['mode']=='unresolved':return p
    if case['mode']=='child_failure':
        p.append(('progress','SETTLED child-1 '+numbers(3,2,0)+' released_steps=2 released_calls=1 released_tokens=2048 released_tools=1 released_scan=4096 unresolved=false'));return p
    p.append(('progress','SETTLED child-1 '+numbers(5,3,1)+' released_steps=0 released_calls=0 released_tokens=0 released_tools=0 released_scan=0 unresolved=false'))
    p += [('progress','EVENT child-1 -> main result child-1: Seen blue'),('progress','EVENT main -> main consume child-1: Seen blue'),('progress','EVENT main -> main tool read: complete: blue<LF>')]
    p += [('progress',x) for x in stage('aggregate',7,4,1)]+[('port','PORT main aggregate')]
    if case['inspect_all']:p.append(('progress',diag('read-aggregate','<redacted>' if case['mode']=='inspect_all_redacted' else case['answer'],case['mode']=='inspect_all_redacted')))
    return p
def transcript(case,console):
    out='CASE '+case['label']+(' console\n' if console else ' collector\n')
    out+=''.join((('' if console else 'COLLECT ') if typ=='progress' else '')+value+'\n' for typ,value in progress(case))
    return out+'PASS '+case['label']+'\n'
def host_trace(path,completed):
    t=json.loads(path.read_text());assert t['schema']=='etas.cli.interpreter-report.v1' and not t.get('incomplete',False) and t['outcome']['kind']==('completed' if completed else 'failed') and t['termination']['local_work_settled'] is True
    starts=[v for v in t['events'] if v['kind']=='host_request_started'];ends=[v for v in t['events'] if v['kind']=='host_request_finished'];a=[v['id'] for v in starts];b=[v['id'] for v in ends]
    assert len(a)==len(set(a))==len(b)==len(set(b)) and set(a)==set(b) and all(v['outcome']['kind']=='succeeded' for v in ends) and all(v['qualified_action'] in ['Policy.evaluate','Console.stdout_write'] for v in starts)
    return {'paired':len(a),'console':sum(v['qualified_action']=='Console.stdout_write' for v in starts),'business_host_operations':0}
def main():
    p=argparse.ArgumentParser();p.add_argument('--evidence-dir',type=Path,required=True);p.add_argument('--prepare-only',action='store_true');args=p.parse_args();args.evidence_dir.mkdir(parents=True,exist_ok=True)
    e=Path(tempfile.mkdtemp(prefix='harness-progress-',dir=args.evidence_dir));project=e/'project';(project/'src/app').mkdir(parents=True);print('EVIDENCE '+str(e),flush=True);items=cases();sources={}
    for src in sorted((ROOT/'src/nomo').rglob('*.es')):
        dst=project/'src'/src.relative_to(ROOT/'src');dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);sources[str(src.relative_to(ROOT))]=hashlib.sha256(src.read_bytes()).hexdigest()
    source=(FIXTURE/'controller_probe.es').read_text();lines=[]
    for i,c in enumerate(items):lines+=['let item_'+str(i)+' = '+source_case(c)+';', 'verify(item_'+str(i)+', false);', 'verify(item_'+str(i)+', true);']
    source=source.replace('__CASES__','\n    '.join(lines));(project/'src/app/harness_progress_probe.es').write_text(source);(project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','harness-progress-probe').replace('app.contract_probe','app.harness_progress_probe'))
    for name in ['wrong_input','wrong_output','extra_error']:
        neg=e/name;shutil.copytree(project,neg);(neg/'src/app/harness_progress_probe.es').unlink();shutil.copyfile(FIXTURE/(name+'.es'),neg/'src/app/callable_negative.es');manifest=neg/'etas.toml';manifest.write_text(manifest.read_text().replace('app.harness_progress_probe','app.callable_negative'))
    result={'status':'prepared','cases':[c['label'] for c in items],'sources':sources,'commands':[],'qualification':'Source Handler progress collector and existing Console adapter, fake main/child; no Model, Fs, Memory, Approval, Command or SSH; abort is source not native Console.'};out=e/'results.json'
    def save():out.write_text(json.dumps(result,indent=2)+'\n')
    save()
    if args.prepare_only:return
    try:
        cli=str(verify_cli());count=len(list((project/'src').rglob('*.es')));env={k:os.environ[k] for k in ['PATH','HOME','LANG','CARGO_HOME','CARGO_TARGET_DIR'] if k in os.environ};env.update(NOMO_NORMAL_GRAPH='latest',ETAS_HOST_FILESYSTEM='none',ETAS_HOST_MEMORY='none',ETAS_HOST_SESSION='none',ETAS_HOST_APPROVAL='deny')
        def invoke(label,argv):
            command=[cli,'--no-config',*map(str,argv)];item={'label':label,'command':command};result['commands'].append(item);save();r=subprocess.run(command,capture_output=True,input=b'',env=env,timeout=240);(e/(label+'.stdout.bin')).write_bytes(r.stdout);(e/(label+'.stderr.bin')).write_bytes(r.stderr);item.update(exit=r.returncode,stdout=r.stdout.decode(),stderr=r.stderr.decode());save();return item
        item=invoke('check',['check','--all',project]);assert item['exit']==0 and not item['stderr'] and item['stdout']=='checked '+str(count)+' files\n'
        item=invoke('effects',['--format','json','effects',project]);assert item['exit']==0 and not item['stderr'];data=json.loads(item['stdout']);assert data['command']=='effects' and not data['diagnostics'];result['effects_captured']=True;save()
        item=invoke('observe',['run',project,'--flow','observe','--allow-effects','--budget-time','45s','--trace-out',e/'observe.trace.json']);expected=''.join(transcript(c,b) for c in items for b in [False,True]);assert item['exit']==0 and not item['stderr'] and item['stdout']==expected,(item['label'],'complete transcript mismatch');result['trace']=host_trace(e/'observe.trace.json',True);save()
        item=invoke('output_abort',['run',project,'--flow','output_abort','--allow-effects','--budget-time','20s','--trace-out',e/'output_abort.trace.json']);assert item['exit']!=0 and item['stdout']=='PORT progress abort\n';diagnostics=item['stderr'].splitlines();assert len(diagnostics)==4 and diagnostics[0]=='error[analysis::ExecutionAborted]: D12_EXPECTED_PROGRESS_ABORT' and str(project/'src/app/harness_progress_probe.es') in diagnostics[1] and 'D12_EXPECTED_PROGRESS_ABORT' in diagnostics[2] and 'D12_EXPECTED_PROGRESS_ABORT' in diagnostics[3];assert 'UNREACHABLE' not in item['stdout']+item['stderr'] and 'UNEXPECTED' not in item['stdout']+item['stderr'];result['abort_trace']=host_trace(e/'output_abort.trace.json',False);save()
        for name,code,message in [('wrong_input','type::TypeMismatch','implementation input type does not satisfy the callable spec'),('wrong_output','type::TypeMismatch','implementation output type does not satisfy the callable spec'),('extra_error','effect::EffectOutsideDeclaredRow','implementation escaping effects do not satisfy the callable spec bound')]:
            neg=e/name;item=invoke(name,['--format','json','check','--all',neg]);assert item['exit']!=0 and not item['stderr'];report=json.loads(item['stdout']);diags=[(Path(f['path']).resolve(),d) for f in report['files'] for d in f['diagnostics']];assert len(diags)==1,(name,diags)
            path,d=diags[0];src=neg/'src/app/callable_negative.es';line=next(i for i,x in enumerate(src.read_text().splitlines(),1) if x.startswith('flow bad('));assert path==src.resolve() and d['severity']=='error' and d['code']==code and d['message']==message and d['primary']['span']['startLine']==line,(name,d)
        result['status']='passed_pending_effect_audit'
    except BaseException as err:result.update(status='failed',failure=repr(err));raise
    finally:
        result['resources'],valid=resources()
        if not valid:result.update(status='failed',resource_failure='ordinary 4GiB guard')
        save();assert valid,str(e)
    print('PASS D12 progress Handler vectors, abort and callable negatives',flush=True)
if __name__=='__main__':main()
