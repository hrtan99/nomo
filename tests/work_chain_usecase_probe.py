#!/usr/bin/env python3
"""D4 typed boundary checks; source handlers and Console only, root lane only."""
import argparse
import json
from pathlib import Path
import re
import shutil
import tempfile

from model_protocol_probe import literal
import terminal_input001_probe as transport
import terminal001_probe as mapping
import session_discovery_probe as discovery
import session_discovery_values_probe as discovery_values

ROOT = Path(__file__).resolve().parent.parent
CAP_KEYS = ['steps','calls','generation','native_tokens','read_tools','scan','edit_reads','edit_read_bytes','atomic','atomic_bytes']
COUNTERS = [13,7,47104,196608,1,4096,3,6144,1,2048]
NEW = ['new','--id','root-op','--child-id','child-op','--workspace','owned','--path','target.txt','--allow','context.txt,other.txt']
CONTINUE = ['continue','--parent','root-op','--id','child-op','--workspace','owned','--path','target.txt','--allow','context.txt,other.txt']
LATEST = ['continue','--latest','--id','child-op','--workspace','owned','--path','target.txt','--allow','context.txt,other.txt']
UNKNOWN = 'v2 work-chain commit unknown; admission retained, no retry'
STOP_ERROR = 'work stopped; inspect captured work and journal state before any further action'
BAD_LINE = 'unknown terminal command; use /help, /show or /exit'
LIMIT = 'terminal input limit reached; inspect captured state; no further request in this process'
MAPPING = ['typed_caps_and_ordered_allowlist_preserved','first_and_second_work_arguments','cap_and_once_projection_preserve_startup_request','invalid_third_or_wrong_initial_work_turn_refused','show_selects_only_explicit_bound_ids','non_tty_once_projects_only_selected_request']
DISCOVERY = ['terminal_latest_and_explicit_parent_remain_separate','terminal_latest_conflicts_and_invalid_startup_refused','unresolved_latest_cannot_dispatch_until_bound']
CASES = {
 'two-completions-no-third':dict(mode='complete',args=NEW,data=b'first\nsecond\nthird\n',reads=2,work=['new','continue'],sessions=['first','second','stopped'],last_turn=2),
 'first-stop-no-next':dict(mode='stop',args=NEW,data=b'first\nsecond\n',reads=1,work=['new'],sessions=['first','stopped'],last_turn=1,status=1,stop=True,errors=[STOP_ERROR]),
 'second-stop-no-next':dict(mode='stop-second',args=NEW,data=b'first\nsecond\nthird\n',reads=2,work=['new','continue'],sessions=['first','second','stopped'],last_turn=2,status=1,stop=True,errors=[STOP_ERROR]),
 'once-completion-no-outer-read':dict(mode='once',args=NEW+['--once','first'],data=b'ignored\n',reads=0,work=['new'],sessions=['first','stopped'],last_turn=1,once=True),
 'once-stop-exact-unknown':dict(mode='once-stop',args=CONTINUE+['--once','second'],data=b'ignored\n',reads=0,work=['continue'],sessions=['second','stopped'],last_turn=2,once=True,status=1,stop=True,errors=[STOP_ERROR]),
 'show-missing-root-before-child':dict(mode='missing',args=CONTINUE,data=b'/show\n/exit\n',reads=2,work=[],sessions=['second'],read=['root-op','child-op'],missing=2),
 'show-captured-root':dict(mode='captured',args=NEW,data=b'/show\n/exit\n',reads=2,work=[],sessions=['first'],read=['root-op'],captured=True),
 'show-first-error-stops':dict(mode='read-fail',args=CONTINUE,data=b'/show\n/exit\n',reads=1,work=[],sessions=['second'],read=['root-op'],status=1,read_failed=True),
 'latest-exact-parent-binding':dict(mode='complete',args=LATEST,data=b'second\nignored\n',reads=1,work=['continue'],sessions=['second','stopped'],last_turn=2,latest=True),
 'latest-distinct-id-refusal':dict(mode='latest-collision',args=LATEST,data=b'ignored\n',reads=0,work=[],sessions=[],latest=True,status=1,errors=['terminal root and child IDs must differ']),
 'malformed-valid-EOF':dict(mode='complete',args=NEW,data=b'/unknown\nfirst\n',reads=3,work=['new'],sessions=['first','second'],errors=[BAD_LINE]),
 'malformed-EOF':dict(mode='complete',args=NEW,data=b'/unknown\n',reads=2,work=[],sessions=['first'],errors=[BAD_LINE]),
 'raw32-limit-no-33rd-read':dict(mode='complete',args=NEW,data=b'/unknown\n'*32+b'first\n',reads=32,work=[],sessions=['first'],errors=[BAD_LINE]*32+[LIMIT],status=1),
 'once-missing-zero-actions':dict(mode='once-missing',args=NEW,data=b'first\n',reads=0,work=[],sessions=[],status=1,errors=['non-TTY terminal mode requires explicit --once REQUEST']),
}


def cap(values):
    return 'Caps { '+', '.join(key+' = '+str(value) for key,value in zip(CAP_KEYS,values))+' }'


def request(*,id='root-op',workspace='owned',path='target.txt',question='first',allowed=None,counters=None,parent=None):
    selected='Selector { id = '+literal(id)+', workspace = '+literal(workspace)+', path = '+literal(path)+' }'
    value='WorkRequest { selected = '+selected+', request = '+literal(question)+', allowed = '+literal(['context.txt','other.txt'] if allowed is None else allowed)+', cap = '+cap(COUNTERS if counters is None else counters)+' }'
    return 'TurnRequest.New('+value+')' if parent is None else 'TurnRequest.Continue(ContinueRequest { parent = '+literal(parent)+', work = '+value+' })'


def pure_cases():
    checks=[]
    def add(label,expressions):checks.append((label,' && '.join(expressions)))
    def invalid(expected,**changes):return 'invalid('+request(**changes)+', '+literal(expected)+')'
    add('typed-selector-invalid-before-dispatch',[invalid('invalid edit operation identity',id=value) for value in ['', 'x'*129,'\x1b']]+[invalid('invalid edit operation identity',workspace='')]+[invalid('invalid relative path',path='../outside')])
    add('typed-question-invalid-before-dispatch',[invalid('question requires 1..128 printable ASCII chars, not only spaces',question=value) for value in ['', ' ', 'x'*129,'x\n','雪']])
    add('typed-allowlist-invalid-before-dispatch',[invalid(reason,allowed=value) for value,reason in [([], 'expected one or two allowed files'),(['a','b','c'],'expected one or two allowed files'),(['../outside'],'invalid allowed file'),(['x'*49],'invalid allowed file'),(['a','a'],'duplicate allowed file')]])
    bad=[]
    for index in range(10):
        for replacement in [-1,COUNTERS[index]+1]:
            values=list(COUNTERS);values[index]=replacement
            bad.append(invalid('invalid current single-turn work-chain policy',counters=values))
    add('all-ten-typed-cap-dimensions-bounded-before-dispatch',bad)
    add('typed-parent-invalid-or-same-before-dispatch',[invalid('invalid edit operation identity',parent=value) for value in ['', 'x'*129]]+[invalid('continuation requires a distinct child ID',parent='root-op')])
    add('typed-unknown-stop-exact-ledger-no-refund',['unchanged('+request()+')','unchanged('+request(id='child-op',parent='root-op',question='second')+')'])
    add('typed-show-invalid-before-dispatch',['invalid_read(Selector { id = "", workspace = "owned", path = "target.txt" }, "invalid edit operation identity")','invalid_read(Selector { id = "root-op", workspace = "owned", path = "../outside" }, "invalid relative path")'])
    add('typed-latest-invalid-before-dispatch',['invalid_latest("", "target.txt", "invalid edit operation identity")','invalid_latest("owned", "../outside", "invalid relative path")'])
    return checks


def rendered(fixture,checks):
    return fixture.replace('__CHECKS__','['+',\n'.join('Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks)+']')


def prepare(source,evidence):
    evidence.mkdir(parents=True,exist_ok=True);folder=Path(tempfile.mkdtemp(prefix='arch-usecase001-',dir=evidence)).resolve()
    project=folder/'project';(project/'src/app').mkdir(parents=True)
    shutil.copytree(source/'src/nomo',project/'src/nomo')
    products={str(p.relative_to(project)):transport.digest(p) for p in sorted((project/'src/nomo').rglob('*.es'))}
    pure=pure_cases(); mapped=[row for row in mapping.cases() if row[0] in MAPPING]
    discoveries=[row for row in discovery.cases() if row[0] in DISCOVERY]
    independent=[row for row in discovery_values.cases() if row[0] in DISCOVERY]
    fixtures={
      'terminal_input_probe.es':('tests/fixtures/terminal_input001/entry_probe.es',None,None),
      'usecase_probe.es':('tests/fixtures/work_chain_usecase001/contract_probe.es',pure,'usecase'),
      'contract_probe.es':('tests/fixtures/terminal001/contract_probe.es',mapped,'mapping'),
      'discovery_probe.es':('tests/fixtures/session_discovery001/contract_probe.es',discoveries,'discovery'),
      'discovery_values.es':('tests/fixtures/session_discovery001/independent_values.es',independent,'independent'),
    }
    flows=[]
    for filename,(relative,checks,tag) in fixtures.items():
        text=(source/relative).read_text()
        if checks is not None:
            text=rendered(text,checks).replace('public flow pure_probe()', 'public flow '+tag+'_values()').replace('public flow observe(', 'public flow '+tag+'_observe(')
        if tag=='discovery':text=text.replace('module app.contract_probe;', 'module app.discovery_probe;')
        if tag=='independent':text=text.replace('module app.contract_probe;', 'module app.discovery_values;')
        (project/'src/app'/filename).write_text(text)
    manifest=transport.MANIFEST
    module_names={'usecase':'app.usecase_probe','mapping':'app.contract_probe','discovery':'app.discovery_probe','independent':'app.discovery_values'}
    manifest+='\n[[bin]]\nname = "typed"\nmodule = "app.terminal_input_probe"\nflow = "typed"\nprofile = "'+transport.PROFILE+'"\n'
    for flow in ['unbound_interactive','unbound_once']:
        manifest+='\n[[bin]]\nname = "'+flow+'"\nmodule = "app.terminal_input_probe"\nflow = "'+flow+'"\nprofile = "'+transport.PROFILE+'"\n'
    for tag,module in module_names.items():
        for kind in ['values','observe']:
            flow=tag+'_'+kind;manifest+='\n[[bin]]\nname = "'+flow+'"\nmodule = "'+module+'"\nflow = "'+flow+'"\nprofile = "'+transport.PROFILE+'"\n';flows.append(flow)
    (project/'etas.toml').write_text(manifest);(project/'etas.lock').write_text(transport.LOCK)
    bindings=['tests/work_chain_usecase_probe.py','tests/terminal_input001_probe.py','tests/terminal001_probe.py','tests/session_discovery_probe.py','tests/session_discovery_values_probe.py','tests/model_protocol_probe.py','tests/normal_graph_identity.py','config/etas-latest-main.json']+[value[0] for value in fixtures.values()]
    package=dict(status='prepared',source=str(source),products=products,source_inputs={name:transport.digest(source/name) for name in bindings},inputs={str(p.relative_to(folder)):transport.digest(p) for p in sorted(project.rglob('*')) if p.is_file()},driver_sha256=transport.digest(Path(__file__)),pure_checks=[name for name,_ in pure],mapping_checks=[name for name,_ in mapped],discovery_checks=[name for name,_ in discoveries],independent_checks=[name for name,_ in independent],case_names=list(CASES),flows=flows,qualification='Source check plus source handlers/Console; fake Completed never establishes admission, edit, durability or release. Original full discovery matrix remains blocked; only changed typed consumer scenarios are selected.')
    transport.save(folder/'package.json',package);print('EVIDENCE '+str(folder),flush=True)


def frozen(source,folder):
    package=json.loads((folder/'package.json').read_text());project=folder/'project'
    transport.require(package['driver_sha256']==transport.digest(Path(__file__)),'Driver changed')
    transport.require(package['inputs']=={str(p.relative_to(folder)):transport.digest(p) for p in sorted(project.rglob('*')) if p.is_file()},'Frozen package changed')
    transport.require(package['products']=={name:transport.digest(source/name) for name in package['products']},'Bound product source changed')
    transport.require(package['source_inputs']=={name:transport.digest(source/name) for name in package['source_inputs']},'Bound test/helper/config inputs changed')
    return package


def command(folder,label,argv,data=b''):
    # 010 binds --flow to the selected bin's module. Use a frozen copy whose
    # first bin is the existing target; preserve every source and bin block.
    argv=list(map(str,argv))
    if '--flow' in argv:
        flow=argv[argv.index('--flow')+1]
        original=Path(argv[2]); manifest=(original/'etas.toml').read_text()
        parts=re.split(r'(?=^\[\[bin\]\]\s*$)',manifest,flags=re.M)
        header,blocks=parts[0],parts[1:]
        names=[]
        for block in blocks:
            match=re.search(r'^name\s*=\s*"([^"]+)"\s*$',block,re.M)
            transport.require(match is not None,'Invalid bin block')
            names.append(match.group(1))
        transport.require(len(names)==len(set(names)) and flow in names,'Ambiguous or missing selected bin')
        index=names.index(flow); project=folder/(label+'-entry-project')
        transport.require(not project.exists(),'Never overwrite a selected-bin project')
        shutil.copytree(original,project)
        (project/'etas.toml').write_text(header+''.join([blocks[index]]+[b for i,b in enumerate(blocks) if i!=index]))
        before={str(p.relative_to(original)):transport.digest(p) for p in original.rglob('*') if p.is_file() and p.relative_to(original)!=Path('etas.toml')}
        after={str(p.relative_to(project)):transport.digest(p) for p in project.rglob('*') if p.is_file() and p.relative_to(project)!=Path('etas.toml')}
        transport.require(before==after,'Selected-bin copy differs from frozen project')
        argv[2]=str(project)
        transport.save(folder/(label+'-entry-inputs.json'),{'flow':flow,'original_manifest_sha256':transport.digest(original/'etas.toml'),'manifest_sha256':transport.digest(project/'etas.toml'),'input_sha256':after,'command':argv})
    row=transport.invoke(folder,label,argv,data=data)
    transport.require(row['exit']==0 and row['stderr']=='',dict(stage=label,exit=row['exit'],stdout_artifact=str(folder/(label+'.stdout.bin')),stderr_artifact=str(folder/(label+'.stderr.bin'))))
    return row


def effect_rows(row):
    transport.support(row)
    result={}
    for key in ['escaping effects','requested actions','default actions']:
        values=re.findall(r'^  '+key+r': \[(.*)\]$',row['stdout'],re.M)
        transport.require(len(values)==1,'Expected one '+key+' row')
        atoms=[];depth=0;start=0
        for index,character in enumerate(values[0]):
            if character in '[<(':depth+=1
            elif character in '])>':depth-=1
            elif character==',' and depth==0:atoms.append(values[0][start:index].strip());start=index+1
        if values[0]:atoms.append(values[0][start:].strip())
        transport.require(depth==0,'Unbalanced action/type display')
        transport.require(len(atoms)==len(set(atoms)),'Duplicate effect/action atom')
        result[key]=set(atoms)
    return result


def controls(source,folder):
    package=frozen(source,folder);cli,resource=transport.identity(source);project=folder/'project'
    result=dict(status='running',commands=[],application_flows=0);path=folder/'controls.json';transport.require(not path.exists(),'Never replace controls');transport.save(path,result)
    try:
        row=command(folder,'source-check',[cli,'check','--all',project]);transport.require(row['stdout']=='checked '+str(len(list((project/'src').rglob('*.es'))))+' files\n','Complete source graph differs');result['commands'].append(row)
        custom={'TerminalWork.execute','TerminalRead.show','TerminalRead.latest'}
        console={'Console.stdout_write','Console.stdin_read_line'}
        for flow in package['flows']+['typed','unbound_interactive','unbound_once','interactive','once']:
            row=command(folder,flow+'-effects',[cli,'effects',project,'--flow',flow]);effects=effect_rows(row);result['commands'].append(row)
            requested=effects['requested actions'];defaults=effects['default actions'];escaping=effects['escaping effects']
            if flow in ['interactive','once']:
                transport.require(custom<=requested and not custom&defaults,'Production root does not interpret all typed operations')
                transport.require(any(action.startswith('Fs.') for action in defaults) and any(action.startswith('Memory.') for action in requested),'Production effects lost original native workflow')
            else:
                if flow=='unbound_once':
                    once_custom={'TerminalWork.execute','TerminalRead.latest'}
                    transport.require(requested==once_custom|{'Console.stdout_write'} and defaults=={'Console.stdout_write'},'Once requested/default operations differ')
                    transport.require(escaping==once_custom|{'Error<std.runtime.error.IndexError>','Error<std.io.IOError>'},'Once escaping effects differ')
                elif flow.startswith('unbound_'):
                    transport.require(requested==custom|console and defaults==console,'Unbound core requested/default operations differ')
                    transport.require(escaping==custom|{'Error<std.runtime.error.IndexError>','Error<std.io.IOError>'},'Unbound core escaping effects differ')
                elif flow=='typed':
                    transport.require(escaping=={'Error<std.runtime.error.IndexError>','Error<std.io.IOError>'},'Typed handler escaping effects differ')
                    transport.require(requested==custom|console and defaults==console,'Source Handlers must retain custom requested actions and default only Console')
                else:
                    transport.require(escaping<={'Error<std.runtime.error.IndexError>','Error<std.io.IOError>'},'Focused values escape business/custom effects')
                    is_usecase=flow.startswith('usecase_');observer=flow.endswith('_observe')
                    expected_requested=(custom if is_usecase else set())|({'Console.stdout_write'} if observer else set())
                    expected_default={'Console.stdout_write'} if observer else set()
                    transport.require(requested==expected_requested and defaults==expected_default,'Focused values/observation requested/default rows differ')
        row=command(folder,'profile',[cli,'run',project,'--flow','typed','--profile',transport.PROFILE,'--budget-time','30s','--print-runtime-profile']);profile=json.loads(row['stdout'])
        transport.require(profile['model'] is None and profile['tools']==[] and profile['filesystem_regions']==[] and profile['command_programs']==[] and profile['memory']['kind']==profile['session']['kind']=='none' and profile['approval']=='Deny' and profile['program_network_endpoints']==profile['adapter_transport_endpoints']==[],'Console-only profile differs')
        result.update(status='passed',profile=profile)
    except BaseException as error:result.update(status='failed',failure=type(error).__name__);raise
    finally:
        result['resources'],valid=resource();transport.require(valid,'4GiB lane guard failed');transport.save(path,result)


def run_values(source,folder,tag):
    package=frozen(source,folder);transport.require(json.loads((folder/'controls.json').read_text())['status']=='passed','Controls first')
    output=folder/tag;output.mkdir();cli,resource=transport.identity(source);result=dict(status='running')
    try:
        flow=tag+'_observe';row=command(output,'observe',[cli,'run',folder/'project','--flow',flow,'--profile',transport.PROFILE,'--allow-effects','--budget-time','30s','--trace-out',output/'trace.json'])
        key={'usecase':'pure_checks','mapping':'mapping_checks','discovery':'discovery_checks','independent':'independent_checks'}[tag]
        transport.require(row['stdout']==''.join('PASS '+name+'\n' for name in package[key]),'Value oracle failed')
        result.update(status='passed',checks=package[key],trace=transport.trace(output/'trace.json'))
    except BaseException as error:result.update(status='failed',failure=type(error).__name__);raise
    finally:result['resources'],valid=resource();transport.save(output/'result.json',result);transport.require(valid,'4GiB lane guard failed')


def session(phase,spec,index):
    selected_turn=2 if phase=='second' or (phase=='stopped' and spec['last_turn']==2) else 1
    return dict(phase=phase,root_id='root-op',current_id='root-op' if selected_turn==1 else 'child-op',turn=str(selected_turn),configured_turns_in_process='0' if phase=='stopped' else '1' if selected_turn==2 or spec.get('once') else '2',workspace='owned',path='target.txt',configured_cap=','.join(map(str,COUNTERS)),once='true' if spec.get('once') else 'false',scope='configuration only; not a durable balance, File observation or permission')


def output_proof(text,spec):
    transport.require(len(text.encode())<=65536 and all(ch=='\n' or 32<=ord(ch)<=126 for ch in text),'Unbounded/non-ASCII output')
    lines=text.splitlines();transport.require(lines and lines[-1]=='TERMINAL_INPUT_RETURN '+str(spec.get('status',0)),'Actual terminal return differs')
    ports=[json.loads(line[10:]) for line in lines if line.startswith('WORK_PORT ')]
    expected=[['new','root-op','','first'] if kind=='new' else ['continue','child-op','root-op','second'] for kind in spec['work']]
    transport.require(ports==expected,'Typed work count/order/binding differs')
    user_lines=[json.loads(line[5:]) for line in lines if line.startswith('USER ')]
    transport.require(user_lines==[[value[3]] for value in expected],'USER text/order differs')
    for index,line in enumerate(lines):
        if line.startswith('WORK_PORT '):
            transport.require(index>0 and lines[index-1].startswith('USER '),'Work no longer immediately follows USER')
            if index+1<len(lines) and not lines[index+1].startswith('REFUSED '):
                transport.require(lines[index+1].startswith('SESSION '),'Completion no longer immediately precedes SESSION')
        if line.startswith('LATEST_PORT '):
            transport.require(index==0,'Latest resolution no longer precedes all SESSION/work output')

    transport.require([json.loads(line[10:]) for line in lines if line.startswith('READ_PORT ')]==[[id,'owned','target.txt'] for id in spec.get('read',[])],'Read ordering/binding differs')
    transport.require([json.loads(line[12:]) for line in lines if line.startswith('LATEST_PORT ')]==([['owned','target.txt']] if spec.get('latest') else []),'Latest count/binding differs')
    sessions=[json.loads(line[8:]) for line in lines if line.startswith('SESSION ')]
    transport.require(sessions==[session(phase,spec,index) for index,phase in enumerate(spec['sessions'])],'Complete configured state/order differs')
    transport.require([json.loads(line[6:]) for line in lines if line.startswith('ERROR ')]==[[reason] for reason in spec.get('errors',[])],'Terminal error/recovery order differs')
    transport.require(lines.count(transport.PROMPT)==spec['reads'],'Prompt/read count differs')
    missing='CHAIN missing; missing data never establishes no edit occurred.';transport.require(lines.count(missing)==spec.get('missing',0),'Missing read qualification differs')
    if spec.get('stop'):
        ledger='LEDGER work steps=2/13 calls=1/7 generation_allowance=2048/47104 native_token_ceiling=8192/196608; per-turn configured allowances are not measured usage; bounded v2 continuation requires a fresh durable claim and current confirmation'
        start=lines.index('REFUSED '+UNKNOWN);transport.require(lines[start:start+4]==['REFUSED '+UNKNOWN,ledger,'NEXT help (run from the project root):','./scripts/local-tryout.sh help'],'Unknown reason/ledger/footer changed')
        transport.require(lines[start+4].startswith('SESSION ') and json.loads(lines[start+4][8:])==sessions[-1],'Stop presentation no longer immediately precedes stopped SESSION')
        transport.require(lines.count('REFUSED '+UNKNOWN)==1,'Duplicate stop presentation')
    if spec.get('read_failed'):transport.require(lines[-4:-1]==['REFUSED bounded read refused','NEXT help (run from the project root):','./scripts/local-tryout.sh help'],'Read failure/footer differs')
    if spec.get('captured'):
        captured=[json.loads(line[6:]) for line in lines if line.startswith('CHAIN {')]
        transport.require(captured==[dict(format='2',phase='admitted',chain='root-op',id='root-op',turn='1',workspace='owned',region='nomo.tools.edit_file.EditableRoot',path='target.txt',parent_id='',parent_version='',parent_digest='',request='captured only')],'Captured row presentation differs')
        for label,values in [('ALLOWANCE ',[26,14,94208,393216,2,8192,6,12288,2,4096]),('AVAILABLE ',COUNTERS),('REMAINING ',COUNTERS),('RESERVATION ',COUNTERS)]:
            transport.require([json.loads(line[len(label):]) for line in lines if line.startswith(label)]==[dict(zip(CAP_KEYS,map(str,values)))],'Captured complete Caps differ')
        transport.require(lines.count('JOURNAL missing; missing journal is not proof that no edit occurred.')==1,'Captured journal qualification differs')
    transport.require(not any(line.startswith(('ADMITTED ','STAGE ','INTENT ','APPLIED ','EDIT completed ','WORK durable ','SAVED ','PREVIEW ')) for line in lines),'Production lifecycle output appeared')
    return dict(work_ports=len(ports),read_ports=len(spec.get('read',[])),latest_ports=int(bool(spec.get('latest'))),sessions=sessions,qualification='Deterministic source handler results only; no production completion/receipt claim.')


def run_case(source,folder,name):
    for prior in (folder/'cases').glob('*/result.json'):
        transport.require(json.loads(prior.read_text())['status']=='passed','Prior failed case stops this invocation; never replay')
    frozen(source,folder);transport.require(json.loads((folder/'controls.json').read_text())['status']=='passed','Controls first')
    output=folder/'cases'/name;output.mkdir(parents=True);spec=CASES[name];cli,resource=transport.identity(source);result=dict(status='running',case=name)
    try:
        row=command(output,'console',[cli,'run',folder/'project','--flow','typed','--profile',transport.PROFILE,'--allow-effects','--budget-time','30s','--trace-out',output/'trace.json','--args',spec['mode'],*spec['args']],spec['data'])
        counts=transport.trace(output/'trace.json');transport.require(counts['console_reads']==spec['reads'],'Actual Console reads differ')
        result.update(status='passed',trace=counts,output=output_proof(row['stdout'],spec))
    except BaseException as error:result.update(status='failed',failure=type(error).__name__);raise
    finally:result['resources'],valid=resource();transport.save(output/'result.json',result);transport.require(valid,'4GiB lane guard failed')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--stage',choices=['prepare','controls','values','case'],required=True);parser.add_argument('--source-root',type=Path,default=ROOT);parser.add_argument('--evidence-dir',type=Path);parser.add_argument('--folder',type=Path);parser.add_argument('--values',choices=['usecase','mapping','discovery','independent']);parser.add_argument('--case',choices=list(CASES));args=parser.parse_args()
    if args.stage=='prepare':prepare(args.source_root,args.evidence_dir)
    elif args.stage=='controls':controls(args.source_root,args.folder)
    elif args.stage=='values':run_values(args.source_root,args.folder,args.values)
    else:run_case(args.source_root,args.folder,args.case)


if __name__=='__main__':main()
