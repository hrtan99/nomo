#!/usr/bin/env python3
"""D11 text provider shared controller with synthetic source handlers."""
import argparse, hashlib, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from harness_checkpoint_contract_probe import MANIFEST, source_literal
from model_protocol_probe import resources
from normal_graph_identity import verify_cli
ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/provider_stage001'

class Source(str):pass

def val(v):return v if isinstance(v,Source) else source_literal(v)
def record(name,d):return name+' { '+', '.join(k+' = '+str(val(v)) for k,v in d.items())+' }'
def event(role,kind,name='',text=''):return dict(role=role,kind=kind,name=name,text=text)
def state(events=None,spent=0,stopped=False):
    events=[] if events is None else events
    return dict(events=events,characters=sum(len(x['name'])+len(x['text']) for x in events),spent=spent,stopped=stopped)
def event_src(e):return record('Event',e)
def state_src(s):return Source(record('State',dict(events=Source('['+', '.join(event_src(x) for x in s['events'])+']'),characters=s['characters'],spent=s['spent'],stopped=s['stopped'])))
def turn_src(t):return Source(record('Turn',dict(state=state_src(t['state']),status=t['status'])))
def context_src(history,request):return Source(record('Context',dict(history=Source('['+', '.join(event_src(x) for x in history)+']'),request=request)))
def make(label,raw='Q',maximum=1,budget=2,initial=None,reply='Answer',status=0,added=None,spent=None,stopped=None,model=True,request=None):
    initial=state() if initial is None else initial;added=[] if added is None else added
    expected=dict(state=state(initial['events']+added,initial['spent'] if spent is None else spent,initial['stopped'] if stopped is None else stopped),status=status)
    return dict(label=label,raw=raw,maximum=maximum,budget=budget,initial=initial,reply=reply,model_expected=model,context=(initial['events'],raw.strip() if request is None else request),expected=expected,added=added)
def case_src(c):
    return Source(record('Case',dict(label=c['label'],raw=c['raw'],maximum=c['maximum'],budget=c['budget'],initial=state_src(c['initial']),reply=c['reply'],model_expected=c['model_expected'],context=context_src(*c['context']),expected=turn_src(c['expected']))))

def vectors():
    u=lambda text:event('user','input','',text);m=event('model','text','qwen','');a=lambda text:event('assistant','final','',text);err=lambda text:event('error','error','',text)
    contexts=[event('tool','complete','read','complete: blue'),event('tool','error','read','untrusted error')];prior=state(contexts)
    cap_event=state([u('x') for _ in range(29)]);cap_content=state([u('x'*7612)]);reject_full=state([u('x') for _ in range(31)])
    def rejected(label,raw,message,initial=None,stopped=None):return make(label,raw,initial=initial,model=False,status=4 if stopped else 2,added=[err(message)],stopped=stopped)
    V=[
        make('trim_success','  Q  ',reply='  Answer\n',added=[u('Q'),m,a('Answer')],spent=1),
        make('prior_tool_history','recall',initial=prior,added=[u('recall'),m,a('Answer')],spent=1),
        make('output_exact_512',reply='x'*512,added=[u('Q'),m,a('x'*512)],spent=1),
        make('output_too_long',reply='x'*513,status=3,added=[u('Q'),m,err('model output exceeds 512 characters')],spent=1),
        make('output_blank',reply='  \n',status=3,added=[u('Q'),m,err('model output is empty')],spent=1),
        make('output_control',reply='a\nb',status=3,added=[u('Q'),m,err('model output must be printable ASCII single-line text')],spent=1),
        make('output_unicode',reply='蓝',status=3,added=[u('Q'),m,err('model output must be printable ASCII single-line text')],spent=1),
        make('step_limit',maximum=0,status=4,added=[u('Q'),err('step limit exhausted')],model=False),
        make('budget_exhausted',budget=0,status=4,added=[u('Q'),err('invocation step budget exhausted')],model=False),
        make('reservation_exhausted',budget=10,initial=state(spent=4),status=4,added=[u('Q'),err('model token reservation exhausted')],model=False),
        make('already_stopped',initial=state(stopped=True),status=4,added=[],model=False),
        rejected('empty_input',' ', 'empty input'),
        rejected('long_input','x'*1025,'input exceeds 1024 characters'),
        rejected('command_input','/x','unsupported command; use /help or /exit in line mode'),
        rejected('invalid_input','a\nb','expected printable ASCII single-line input'),
        make('context_exact','x'*896,added=[u('x'*896),m,a('Answer')],spent=1),
        rejected('context_over','x'*897,'model context capacity exhausted'),
        make('event_capacity',initial=cap_event,status=4,added=[err('history event capacity exhausted; start a new invocation')],stopped=True,model=False),
        make('content_capacity',initial=cap_content,status=4,added=[err('history content capacity exhausted; start a new invocation')],stopped=True,model=False),
        rejected('reject_capacity','', 'history event capacity exhausted; start a new invocation',initial=reject_full,stopped=True),
    ]
    first=make('no_refund_first',budget=1,reply='x'*513,status=3,added=[u('Q'),m,err('model output exceeds 512 characters')],spent=1)
    second=make('no_refund_second','again',budget=1,initial=first['expected']['state'],status=4,added=[u('again'),err('invocation step budget exhausted')],model=False)
    first_ok=make('two_turn_first',raw='first',added=[u('first'),m,a('Answer')],spent=1)
    second_ok=make('two_turn_second',raw='again',initial=first_ok['expected']['state'],added=[u('again'),m,a('Answer')],spent=2)
    return V,[(first,second),(first_ok,second_ok)]

def render_event(e,console):
    if not console:return 'EVENT '+json.dumps([e['role'],e['kind'],e['name'],e['text']],ensure_ascii=True,separators=(',',':'))+'\n'
    if e['kind']=='error':return 'error: '+e['text']+'\n'
    if e['role']=='model':return 'model: text '+e['name']+'\n'
    if e['role']=='tool':return 'tool: '+e['name']+': '+e['text']+'\n'
    return e['role']+': '+e['text']+'\n'
def transcript(c,console):
    out='CASE '+c['label']+(' console\n' if console else ' collector\n')
    for e in c['added']:
        out+=render_event(e,console)
        if e['role']=='model' and e['kind']=='text':out+='PORT model\n'
    return out+'PASS '+c['label']+'\n'

def host_trace(path,completed):
    t=json.loads(path.read_text());assert t['schema']=='etas.cli.interpreter-report.v1' and not t.get('incomplete',False) and t['outcome']['kind']==('completed' if completed else 'failed') and t['termination']['local_work_settled'] is True
    starts=[v for v in t['events'] if v['kind']=='host_request_started'];ends=[v for v in t['events'] if v['kind']=='host_request_finished'];a=[v['id'] for v in starts];b=[v['id'] for v in ends]
    assert len(a)==len(set(a))==len(b)==len(set(b)) and set(a)==set(b) and all(v['outcome']['kind']=='succeeded' for v in ends)
    assert all(v['qualified_action'] in ['Policy.evaluate','Console.stdout_write'] for v in starts)
    return {'paired':len(a),'console':sum(v['qualified_action']=='Console.stdout_write' for v in starts),'business_host_operations':0}

def main():
    p=argparse.ArgumentParser();p.add_argument('--evidence-dir',type=Path,required=True);p.add_argument('--prepare-only',action='store_true');args=p.parse_args();args.evidence_dir.mkdir(parents=True,exist_ok=True)
    e=Path(tempfile.mkdtemp(prefix='provider-stage-',dir=args.evidence_dir));project=e/'project';(project/'src/app').mkdir(parents=True);print('EVIDENCE '+str(e),flush=True);items,pairs=vectors();sources={}
    for src in sorted((ROOT/'src/nomo').rglob('*.es')):
        dst=project/'src'/src.relative_to(ROOT/'src');dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);sources[str(src.relative_to(ROOT))]=hashlib.sha256(src.read_bytes()).hexdigest()
    source=(FIXTURE/'controller_probe.es').read_text();lines=[]
    for i,c in enumerate(items):
        lines+=['let case_'+str(i)+' = '+case_src(c)+';', 'let observed_'+str(i)+'a = verify(case_'+str(i)+', case_'+str(i)+'.initial, false);', 'let observed_'+str(i)+'b = verify(case_'+str(i)+', case_'+str(i)+'.initial, true);']
    twolines=[]
    for i,(a,b) in enumerate(pairs):
        twolines+=['let first_'+str(i)+' = '+case_src(a)+';', 'let second_'+str(i)+' = '+case_src(b)+';', 'let pair_'+str(i)+'a = verify(first_'+str(i)+', first_'+str(i)+'.initial, false);', 'let pair_'+str(i)+'b = verify(second_'+str(i)+', pair_'+str(i)+'a.state, false);', 'let pair_'+str(i)+'c = verify(first_'+str(i)+', first_'+str(i)+'.initial, true);', 'let pair_'+str(i)+'d = verify(second_'+str(i)+', pair_'+str(i)+'c.state, true);']
    source=source.replace('__CASES__','\n    '.join(lines)).replace('__TWO_TURNS__','\n    '.join(twolines)).replace('__EMPTY__',state_src(state()))
    (project/'src/app/provider_stage_probe.es').write_text(source);(project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','provider-stage-probe').replace('app.contract_probe','app.provider_stage_probe'))
    for name in ['wrong_input','wrong_output','extra_error']:
        neg=e/name;shutil.copytree(project,neg);(neg/'src/app/provider_stage_probe.es').unlink();shutil.copyfile(FIXTURE/(name+'.es'),neg/'src/app/callable_negative.es');manifest=neg/'etas.toml';manifest.write_text(manifest.read_text().replace('app.provider_stage_probe','app.callable_negative'))
    record_out={'status':'prepared','cases':[x['label'] for x in items],'pairs':[[a['label'],b['label']] for a,b in pairs],'sources':sources,'commands':[],'qualification':'Deterministic source ModelText and output handlers only; no Model, Fs, Memory, Approval, Command or SSH; no real provider JSON wire verification.'};out=e/'results.json'
    def save():out.write_text(json.dumps(record_out,indent=2)+'\n')
    save()
    if args.prepare_only:return
    try:
        cli=str(verify_cli());count=len(list((project/'src').rglob('*.es')));env={k:os.environ[k] for k in ['PATH','HOME','LANG','CARGO_HOME','CARGO_TARGET_DIR'] if k in os.environ};env.update(NOMO_NORMAL_GRAPH='latest',ETAS_HOST_FILESYSTEM='none',ETAS_HOST_MEMORY='none',ETAS_HOST_SESSION='none',ETAS_HOST_APPROVAL='deny')
        def invoke(label,argv):
            command=[cli,'--no-config',*map(str,argv)];item={'label':label,'command':command};record_out['commands'].append(item);save();r=subprocess.run(command,capture_output=True,input=b'',env=env,timeout=240);(e/(label+'.stdout.bin')).write_bytes(r.stdout);(e/(label+'.stderr.bin')).write_bytes(r.stderr);item.update(exit=r.returncode,stdout=r.stdout.decode(),stderr=r.stderr.decode());save();return item
        item=invoke('check',['check','--all',project]);assert item['exit']==0 and not item['stderr'] and item['stdout']=='checked '+str(count)+' files\n'
        item=invoke('effects',['--format','json','effects',project]);assert item['exit']==0 and not item['stderr'];data=json.loads(item['stdout']);assert data['command']=='effects' and not data['diagnostics'];record_out['effects_captured']=True;save()
        expected='PASS provider_context_compatibility\n'+''.join(transcript(c,b) for c in items for b in [False,True])+''.join(transcript(c,backend) for a,b in pairs for backend in [False,True] for c in [a,b])
        item=invoke('observe',['run',project,'--flow','observe','--allow-effects','--budget-time','45s','--trace-out',e/'observe.trace.json']);assert item['exit']==0 and not item['stderr'] and item['stdout']==expected,(item['label'],'complete transcript mismatch');record_out['trace']=host_trace(e/'observe.trace.json',True);save()
        for name,marker,port in [('model_abort','D11_EXPECTED_MODEL_ABORT','PORT abort model'),('output_abort','D11_EXPECTED_OUTPUT_ABORT','PORT abort output')]:
            item=invoke(name,['run',project,'--flow',name,'--allow-effects','--budget-time','20s','--trace-out',e/(name+'.trace.json')]);assert item['exit']!=0
            expected_abort = (render_event(event('user','input','','Q'),False)+render_event(event('model','text','qwen',''),False)+port+'\n') if name=='model_abort' else port+'\n'
            assert item['stdout']==expected_abort,(name,'unexpected complete stdout',item['stdout'])
            diagnostics=item['stderr'].splitlines();assert len(diagnostics)==4 and diagnostics[0]=='error[analysis::ExecutionAborted]: '+marker and str(project/'src/app/provider_stage_probe.es') in diagnostics[1] and marker in diagnostics[2] and marker in diagnostics[3],(name,diagnostics)
            assert 'UNREACHABLE' not in item['stdout']+item['stderr'] and 'UNEXPECTED' not in item['stdout']+item['stderr'];record_out[name+'_trace']=host_trace(e/(name+'.trace.json'),False);save()
        for name,code,message in [('wrong_input','type::TypeMismatch','implementation input type does not satisfy the callable spec'),('wrong_output','type::TypeMismatch','implementation output type does not satisfy the callable spec'),('extra_error','effect::EffectOutsideDeclaredRow','implementation escaping effects do not satisfy the callable spec bound')]:
            neg=e/name;item=invoke(name,['--format','json','check','--all',neg]);assert item['exit']!=0 and not item['stderr'];report=json.loads(item['stdout']);diags=[(Path(f['path']).resolve(),d) for f in report['files'] for d in f['diagnostics']];assert len(diags)==1,(name,diags)
            path,d=diags[0];src=neg/'src/app/callable_negative.es';line=next(i for i,x in enumerate(src.read_text().splitlines(),1) if x.startswith('flow bad('));assert path==src.resolve() and d['severity']=='error' and d['code']==code and d['message']==message and d['primary']['span']['startLine']==line,(name,d)
        record_out['status']='passed_pending_effect_audit'
    except BaseException as err:record_out.update(status='failed',failure=repr(err));raise
    finally:
        record_out['resources'],valid=resources()
        if not valid:record_out.update(status='failed',resource_failure='ordinary 4GiB guard')
        save();assert valid,str(e)
    print('PASS D11 provider source handler vectors and negatives',flush=True)
if __name__=='__main__':main()
