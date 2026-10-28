#!/usr/bin/env python3
"""Terminal source-only pure values; no work entry or durable test lifetime."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from edit_contract_probe import record
from edit_write_probe import ascii_json
from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import literal, resources
from normal_graph_identity import verify_cli
from work_chain_contract_probe import MODULES as CHAIN_MODULES

ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/terminal001/contract_probe.es'
MODULES=CHAIN_MODULES+['cli/work_chain_args.es','cli/terminal_args.es','ui/terminal_session.es']
CAP='13,7,47104,196608,1,4096,3,6144,1,2048'
REQUEST='replace selected literal'
NEW=['new','--id','root-op','--child-id','child-op','--workspace','owned','--path','target.txt','--allow','context.txt']
CONTINUE=['continue','--parent','root-op','--id','child-op','--workspace','owned','--path','target.txt','--allow','context.txt']
BINDING=dict(help=False,root_id='root-op',child_id='child-op',parent='',workspace='owned',path='target.txt',allowed=['context.txt'],cap_raw='',once_supplied=False,once='')


def cases():
    checks=[]
    def add(label,*expressions):checks.append((label,' && '.join(expressions)))
    def call(name,*values):return name+'('+', '.join(map(literal,values))+')'
    def parsed(args,**changes):return 'parsed('+literal(args)+', '+record('Config',dict(BINDING,**changes))+')'
    def denied(*args):return [call('refused',value) for value in args]
    def once_parsed(args,**changes):
        expected=dict(BINDING,once_supplied=True,once=REQUEST);expected.update(changes)
        return 'once_parsed('+literal(args)+', '+record('Config',expected)+')'
    def argv(turn,request=REQUEST,cap=''):
        value=['--id','root-op' if turn==1 else 'child-op','--workspace','owned','--path','target.txt','--once',request,'--allow','context.txt']
        if turn==2:value+=['--parent','root-op']
        if cap:value+=['--cap',cap]
        return value
    def selected(turn):return ['--id','root-op' if turn==1 else 'child-op','--workspace','owned','--path','target.txt']
    def rendered(state,turn,phase,remaining,once=False,root='root-op',child='child-op',workspace='owned',path='target.txt',cap=''):
        expected='SESSION '+ascii_json(dict(phase=phase,root_id=root,current_id=root if turn==1 else child,turn=str(turn),configured_turns_in_process=str(remaining),workspace=workspace,path=path,configured_cap=cap or 'work-chain defaults',once='true' if once else 'false',scope='configuration only; not a durable balance, File observation or permission'))
        return 'rendered('+state+', '+', '.join(map(literal,[root,child,workspace,path,cap,once,expected]))+')'
    add('standalone_help_without_binding',*[parsed(args,help=True,root_id='',child_id='',workspace='',path='',allowed=[]) for args in [['help'],['--help']]])
    add('new_and_explicit_parent_bindings',parsed(NEW),parsed(CONTINUE,parent='root-op'))
    add('once_and_cap_are_literal_pairs',parsed(NEW+['--cap',CAP,'--once','--help'],cap_raw=CAP,once_supplied=True,once='--help'),parsed(CONTINUE+['--once','  selected  '],parent='root-op',once_supplied=True,once='  selected  '))
    add('empty_missing_unknown_or_mixed_mode_refused',*denied([],NEW[:-1],['--help',*NEW[1:]],['new','--help'],['resume',*NEW[1:]],NEW[:3]+['--other',NEW[4]]+NEW[5:]))
    add('duplicate_options_refused',*denied(NEW+['--id','other'],NEW+['--allow','other.txt'],NEW+['--once','x','--once','y'],NEW+['--cap',CAP,'--cap',CAP]))
    add('distinct_and_explicit_ids_required',*denied(NEW[:4]+['root-op']+NEW[5:],NEW[:3]+NEW[5:],CONTINUE[:1]+CONTINUE[3:],NEW[:5]+['--parent','parent-op']+NEW[7:],CONTINUE[:5]+['--child-id','another-op']+CONTINUE[7:]))
    add('invalid_identity_workspace_or_path_refused',*denied(NEW[:2]+['']+NEW[3:],NEW[:2]+['\x1b']+NEW[3:],NEW[:6]+['雪']+NEW[7:],NEW[:8]+['../outside']+NEW[9:]))
    add('allowlist_binding_limits',parsed(NEW[:-1]+['a'*48+','+'b'*48],allowed=['a'*48,'b'*48]),*denied(NEW[:-1]+['a'*49],NEW[:-1]+['context.txt,context.txt'],NEW[:-1]+['a.txt,b.txt,c.txt']))
    add('cap_shape_is_canonical',parsed(NEW+['--cap','0,0,0,0,0,0,0,0,0,0'],cap_raw='0,0,0,0,0,0,0,0,0,0'),*denied(NEW+['--cap',''],NEW+['--cap','013,7,47104,196608,1,4096,3,6144,1,2048'],NEW+['--cap','13,7'],NEW+['--cap','13,7,47104,196608,1,4096,3,6144,1,2049']))
    add('once_request_bounds_and_controls',parsed(NEW+['--once','x'*128],once_supplied=True,once='x'*128),*denied(NEW+['--once','x'*129],NEW+['--once',''],NEW+['--once',' '],NEW+['--once','x\n'],NEW+['--once','雪']))
    add('finite_line_commands_and_framing',*[call('command',raw,kind,'') for raw,kind in [('/help','help'),(' /help \n','help'),('/show\r\n','show'),('/exit\n','exit')]])
    add('EOF_is_distinct_from_blank_line',call('command','','eof',''),call('command','\n','invalid',''),call('command','\r\n','invalid',''),call('command',' ','invalid',''))
    add('line_request_text_and_ascii_punctuation',call('command','  replace "quoted" \\ text  \r\n','request','replace "quoted" \\ text'),call('command','change path/a.txt','request','change path/a.txt'))
    add('raw_payload128_before_trim',*[call('command','x'*128+ending,'request','x'*128) for ending in ['','\n','\r\n']],*[call('command',raw,'invalid','') for raw in ['x'*129,'x'*129+'\n','x'*128+' \n',' '*129+'\n']])
    add('line_controls_cannot_disappear_through_trim',*[call('command',raw,'invalid','') for raw in ['\t/help','/show\t','x\ny','x\ry','x\r','\v/help','\f/help','\x1b[2J','x\x7f','\u00a0/help','雪','x\0']])
    add('unknown_slash_commands_refused',*[call('command',raw,'invalid','') for raw in ['/unknown','/show extra','/Help','/']],call('command','path/a.txt','request','path/a.txt'))
    add('help_show_exit_EOF_are_non_work_intents',*[call('non_work',raw) for raw in ['/help\n','/show\r\n','/exit','']])
    add('first_and_second_work_arguments',call('work',NEW,1,REQUEST,argv(1)),call('work',NEW,2,REQUEST,argv(2)),call('work',CONTINUE,2,REQUEST,argv(2)))
    add('cap_and_once_projection_preserve_startup_request',call('work',NEW+['--cap',CAP,'--once','--help'],1,'--help',argv(1,'--help',CAP)),call('work_refused',NEW+['--once',REQUEST],1,'substituted request'),call('work_refused',NEW+['--once',REQUEST],2,REQUEST),call('work',CONTINUE+['--once',REQUEST],2,REQUEST,argv(2)))
    add('invalid_third_or_wrong_initial_work_turn_refused',*[call('work_refused',NEW,turn,REQUEST) for turn in [0,3,-1]],call('work_refused',CONTINUE,1,REQUEST),call('work_refused',NEW,1,'x'*129))
    add('show_selects_only_explicit_bound_ids',*[call('selected',args,turn,selected(turn)) for args in [NEW,CONTINUE] for turn in [1,2]],*[call('selection_refused',NEW,turn) for turn in [0,3,-1]])
    add('confirmed_first_advances_and_second_stops','sequence()')
    add('once_and_failure_stop_without_retry',call('transition',False,True,True,1,True),call('transition',False,False,False,1,True),call('transition',True,False,False,2,True),call('transition',True,True,True,2,True),*[call('stopped_refused',last) for last in [0,1,2,3]])
    add('configured_session_rendering',rendered('State.First',1,'first',2),rendered('State.Second',2,'second',1),rendered('State.Stopped(1)',1,'stopped',0),rendered('State.Stopped(2)',2,'stopped',0))
    add('once_render_has_one_configured_turn',rendered('State.First',1,'first',1,once=True),rendered('State.Second',2,'second',1,once=True,cap=CAP))
    add('state_metadata_is_ascii_escaped_not_authority',rendered('State.Second',2,'second',1,root='r"\\\x1b雪',child='c\n😀',workspace='owned\r',path='path\tname',cap='x\x1b'))
    add('invalid_stopped_render_turn_refused',*[call('render_refused',last) for last in [0,3,-1]])
    values=['literal "quoted" \\ text','\x1b[2J\n\r\t\x7f\x85\u202e雪😀','x'*128]
    add('user_echo_is_ascii_escaped',*[call('rendered_request',value,'USER '+ascii_json([value])) for value in values],call('request_render_refused','x'*129))
    add('non_tty_once_help_without_binding',*[once_parsed(args,help=True,root_id='',child_id='',workspace='',path='',allowed=[],once_supplied=False,once='') for args in [['help'],['--help']]])
    add('non_tty_once_requires_explicit_request',call('once_required',NEW),call('once_required',CONTINUE),call('once_refused',NEW+['--once']))
    add('non_tty_once_keeps_literal_startup_values',once_parsed(NEW+['--once',REQUEST]),once_parsed(CONTINUE+['--cap',CAP,'--once',REQUEST],parent='root-op',cap_raw=CAP),once_parsed(NEW+['--once','--help'],once='--help'),once_parsed(NEW+['--once','x'*128],once='x'*128))
    add('non_tty_once_refuses_conflicts_and_invalid_values',*[call('once_refused',args) for args in [NEW+['--once','x','--once','y'],NEW+['--once',REQUEST,'--cap',''],NEW+['--once',''],NEW+['--once',' '],NEW+['--once','x'*129],NEW+['--once','x\n'],NEW+['--once','雪'],['--help',*NEW[1:],'--once',REQUEST]]])
    add('non_tty_once_projects_only_selected_request',call('once_work',NEW+['--cap',CAP,'--once',REQUEST],1,REQUEST,argv(1,cap=CAP)),call('once_work',CONTINUE+['--once',REQUEST],2,REQUEST,argv(2)),*[call('once_work_refused',args,selected_turn,request) for args,selected_turn,request in [(NEW+['--once',REQUEST],2,REQUEST),(CONTINUE+['--once',REQUEST],1,REQUEST),(NEW+['--once',REQUEST],3,REQUEST),(CONTINUE+['--once',REQUEST],3,REQUEST),(NEW+['--once',REQUEST],1,'substituted request')]])
    assert 0<len(checks)<=64 and len(checks)==len({label for label,_ in checks})
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--prepare-only',action='store_true')
    parser.add_argument('--once-only',action='store_true',help='Select only the new non-TTY one-shot pure groups')
    options=parser.parse_args();checks=cases()
    if options.once_only:checks=[check for check in checks if check[0].startswith('non_tty_once_')]
    options.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='terminal001-pure-',dir=options.evidence_dir)).resolve();project=evidence/'project';(project/'src/app').mkdir(parents=True)
    print('EVIDENCE '+str(evidence),flush=True);sources={}
    for name in dict.fromkeys(MODULES):
        source=ROOT/'src/nomo'/name;target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);sources[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
    generated=FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join('Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks)+']')
    (project/'src/app/contract_probe.es').write_text(generated)
    manifest=MANIFEST.replace('harness-checkpoint-contract-probe','terminal001-pure-probe');(project/'etas.toml').write_text(manifest)
    result=dict(task='TERMINAL-002-source-once' if options.once_only else 'terminal-source-pure',status='prepared',source_only=True,checks=[label for label,_ in checks],sources=sources,commands=[],fixture_sha256=hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),generated_sha256=hashlib.sha256(generated.encode()).hexdigest(),effect_proofs_passed=False,
        execution_boundary=dict(Model_provider_calls=0,native_v2_admissions=0,durable_work_test_lifetimes=0,product_File_Memory_edit_operations=0,actual_PTY_cancellation_integration=False),
        qualification='Pure startup/command/state/rendering values only. The copied project has no Actor or work entry; empty pure effects and Console-only observation must pass before execution. This is not a native terminal/workflow, TTY, cancellation, persistence or backend-adherence proof.')
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(result,indent=2)+'\n');save()
    if options.prepare_only:return
    try:
        cli=verify_cli();count=len(list((project/'src').rglob('*.es')))
        commands=[('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),('pure-effects',[cli,'effects',project,'--flow','pure_probe'],None),('observe-effects',[cli,'effects',project,'--flow','observe'],None),('observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+label+'\n' for label,_ in checks))]
        for label,argv,expected in commands:
            if label=='observe':assert result['effect_proofs_passed']
            item=dict(label=label,command=list(map(str,argv)));result['commands'].append(item);save();observed=subprocess.run(item['command'],capture_output=True,timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save()
            assert observed.returncode==0 and not observed.stderr,(label,observed.returncode,str(evidence))
            if expected is not None:assert item['stdout']==expected,(label,str(evidence))
            elif label=='pure-effects':assert item['stdout'].count('requested actions: []')==item['stdout'].count('default actions: []')==1
            else:
                assert item['stdout'].count('requested actions: [Console.stdout_write]')==item['stdout'].count('default actions: [Console.stdout_write]')==1
                result['effect_proofs_passed']=True;save()
        result['status']='passed'
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources'],valid=resources()
        if not valid:result.update(status='failed',resource_failure='ordinary4GiB resource guard software bug')
        save();assert valid,str(evidence)
    print('PASS '+str(len(checks))+' grouped source-only terminal contracts; zero admissions',flush=True)


if __name__=='__main__':main()
