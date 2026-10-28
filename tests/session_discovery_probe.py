#!/usr/bin/env python3
"""Focused session discovery values and source handlers; zero work lifecycles."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import literal, resources
from normal_graph_identity import verify_cli
from terminal001_probe import MODULES as TERMINAL_MODULES

ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/session_discovery001/contract_probe.es'
MODULES=TERMINAL_MODULES+['session/work_chain_journal_contract.es','session/work_chain_selection.es',
    'session/work_chain_observation.es','cli/work_chain_selection_args.es']
BIND=['--workspace','owned','--path','target.txt']
LATEST=['continue','--latest','--id','child-op',*BIND,'--allow','context.txt']
EXPLICIT=['continue','--parent','root-op','--id','child-op',*BIND,'--allow','context.txt']
REQUEST='replace selected literal'
CAP='13,7,47104,196608,1,4096,3,6144,1,2048'

def cases():
    values=[]
    def add(label,*checks):values.append((label,' && '.join(checks)))
    def call(name,*args):return name+'('+', '.join(map(literal,args))+')'
    add('strict_fixed_store_list_and_standalone_help',call('parsed',BIND,True,'all'),*[call('parsed',args,listing,'help') for args in [['help'],['--help']] for listing in [True,False]])
    add('exact_and_latest_are_distinct_selectors',call('parsed',['--latest',*BIND],False,'latest'),call('parsed',['--id','root-op',*BIND],False,'root-op'),call('parsed',['--id','--latest',*BIND],False,'--latest'))
    add('selector_conflicts_duplicates_missing_and_unknown_refused',*[call('parsed',args,listing,'refused') for args,listing in [
        (BIND,False),(['--latest',*BIND],True),(['--id','root-op',*BIND],True),(['--latest','--id','root-op',*BIND],False),
        (['--latest','--latest',*BIND],False),(['--id','root-op','--id','root-op',*BIND],False),
        (['--latest','--workspace','owned','--workspace','owned','--path','target.txt'],False),
        (['--latest','--workspace','owned','--path'],False),(['--latest','--workspace','','--path','target.txt'],False),
        (['--latest','--workspace','owned','--path','../outside'],False),(['--latest',*BIND,'--other','x'],False),(['--help',*BIND],False)]])
    add('terminal_latest_and_explicit_parent_remain_separate',call('terminal_parsed',LATEST,True),call('terminal_parsed',LATEST+['--once',REQUEST,'--cap',CAP],True),call('terminal_parsed',EXPLICIT,False),call('terminal_parsed',LATEST+['--once','--latest'],True))
    add('terminal_latest_conflicts_and_invalid_startup_refused',*[call('terminal_refused',args) for args in [
        LATEST+['--parent','root-op'],LATEST+['--parent',''],LATEST+['--latest'],
        ['new','--latest','--id','root-op','--child-id','child-op',*BIND,'--allow','context.txt'],
        ['continue','--latest','--id','',*BIND,'--allow','context.txt'],LATEST+['--once',''],LATEST+['--once','x'*129]]])
    expected=['--id','child-op',*BIND,'--once',REQUEST,'--allow','context.txt','--parent','root-op']
    add('unresolved_latest_cannot_dispatch_until_bound',call('latest_bound',LATEST,'root-op',expected),call('latest_bound',LATEST+['--once',REQUEST],'root-op',expected),call('latest_bound',LATEST+['--cap',CAP],'root-op',expected+['--cap',CAP]),call('latest_bind_refused',LATEST,'child-op'),call('latest_bind_refused',EXPLICIT,'root-op'),call('once_missing',LATEST))
    add('empty_store_is_not_a_parent_or_no_edit_proof',call('selected','empty','all',[]),call('selected','empty','latest',[]),call('selection_refused','empty','parent'),call('observation','empty','same',True))
    add('admitted_and_partial_roots_are_inspectable_not_eligible',call('latest_metadata','admitted','admitted','missing',False),call('latest_metadata','partial','summary-unconfirmed','completed',False),*[call('selection_refused',kind,'parent') for kind in ['admitted','partial']],*[call('observation',kind,'same',True) for kind in ['admitted','partial']])
    add('confirmed_first_is_only_eligible_parent',call('selected','confirmed','parent',['root-op']),call('selected','confirmed','latest',['root-op']),call('latest_metadata','confirmed','summary-confirmed','completed',True),call('observation','confirmed','same',True))
    add('highest_child_never_falls_back_to_root',*[call('selected',kind,'latest',['child-op']) for kind in ['child_admitted','child_partial','child_confirmed']],*[call('selection_refused',kind,'parent') for kind in ['child_admitted','child_partial','child_confirmed']],*[call('selected',kind,'root-op',['root-op']) for kind in ['child_admitted','child_partial','child_confirmed']],call('selected','child_confirmed','all',['root-op','child-op']))
    add('each_child_phase_preserves_captured_journal_meaning',call('latest_metadata','child_admitted','admitted','missing',False),call('latest_metadata','child_partial','summary-unconfirmed','completed',False),call('latest_metadata','child_confirmed','summary-confirmed','completed',False))
    add('unknown_id_and_explicit_binding_mismatch_refused',call('selection_refused','confirmed','missing-id'),call('binding_refused','foreign','target.txt'),call('binding_refused','owned','other.txt'))
    add('orphan_slots_and_journals_refuse_entire_selection',call('invalid_graph','child_confirmed','root_absent'),call('invalid_graph','confirmed','root_absent'),call('invalid_graph','confirmed','orphan_second_journal'),call('invalid_graph','child_confirmed','child_absent'))
    add('lineage_slot_and_journal_predicates_are_reused',*[call('invalid_graph','child_confirmed',mode) for mode in ['lineage','root_key','child_key']],*[call('invalid_graph','confirmed',mode) for mode in ['root_value','journal_key','journal_format','journal_chain','journal_phase','journal_absent']])
    add('admitted_intent_never_grants_continuation',call('latest_metadata','admitted_intent','admitted','intent',False),call('selection_refused','admitted_intent','parent'),call('observation','admitted_intent','same',True))
    add('all_four_observation_versions_are_compared',*[call('observation','child_confirmed',mode,False) for mode in ['root_version','child_version','journal_version','child_journal_version']])
    add('presence_absence_and_values_cannot_change_during_read',call('observation','empty','present_after_empty',False),*[call('observation','child_confirmed',mode,False) for mode in ['root_absent','child_absent','journal_absent','child_journal_absent','root_value','journal_phase']])
    add('source_handler_refusal_stops_without_empty_fallback',call('observation_error',False),call('observation_error',True),'invalid_binding_before_capture()')
    assert len(values)==18 and len(values)==len({label for label,_ in values})
    return values

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir',type=Path,required=True);parser.add_argument('--prepare-only',action='store_true')
    args=parser.parse_args();checks=cases();args.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='session-discovery-pure-',dir=args.evidence_dir)).resolve()
    project=evidence/'project';(project/'src/app').mkdir(parents=True);sources={}
    print('EVIDENCE '+str(evidence),flush=True)
    for name in dict.fromkeys(MODULES):
        source=ROOT/'src/nomo'/name;target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        sources[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
    generated=FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join('Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks)+']')
    (project/'src/app/contract_probe.es').write_text(generated);(project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','session-discovery-pure-probe'))
    record=dict(task='SESSION-DISCOVERY-001-pure',status='prepared',checks=[label for label,_ in checks],sources=sources,commands=[],effect_proofs_passed=False,
        execution_boundary=dict(Model_calls=0,work_admissions=0,work_lifecycles=0,product_File_Memory_operations=0),
        qualification='Same observation controller with deterministic source handlers; typed values only. No actual store, Model, File, approval, receipt or lifecycle proof.')
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(record,indent=2)+'\n');save()
    if args.prepare_only:return
    try:
        cli=verify_cli();count=len(list((project/'src').rglob('*.es')))
        commands=[('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),
            ('unhandled-effects',[cli,'effects',project,'--flow','unhandled_probe'],None),
            ('pure-effects',[cli,'effects',project,'--flow','pure_probe'],None),
            ('observe-effects',[cli,'effects',project,'--flow','observe'],None),
            ('observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+label+'\n' for label,_ in checks))]
        for label,argv,expected in commands:
            if label=='observe':assert record['effect_proofs_passed']
            item=dict(label=label,command=list(map(str,argv)));record['commands'].append(item);save()
            value=subprocess.run(item['command'],capture_output=True,timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(value.stdout);(evidence/(label+'.stderr.bin')).write_bytes(value.stderr)
            item.update(exit=value.returncode,stdout=value.stdout.decode(),stderr=value.stderr.decode());save()
            assert value.returncode==0 and not value.stderr,(label,str(evidence))
            if expected is not None:assert item['stdout']==expected,(label,str(evidence))
            elif label=='unhandled-effects':
                requested=next(line for line in item['stdout'].splitlines() if 'requested actions:' in line)
                assert 'SessionObservation.capture' in requested and all(word not in requested for word in ['Memory.','Model.','Agentic.','Fs.','Console.'])
            elif label=='pure-effects':assert item['stdout'].count('requested actions: [SessionObservation.capture]')==item['stdout'].count('default actions: []')==1
            else:
                assert item['stdout'].count('requested actions: [Console.stdout_write, SessionObservation.capture]')==item['stdout'].count('default actions: [Console.stdout_write]')==1
            if label.endswith('-effects'):
                assert 'support: rejected[' not in item['stdout'],(label,'source handler support rejected; full18 validation remains OPEN',str(evidence))
                if label=='observe-effects':record['effect_proofs_passed']=True;save()
        record['status']='passed'
    except BaseException as error:record.update(status='failed',failure=repr(error));raise
    finally:
        record['resources'],valid=resources()
        if not valid:record.update(status='failed',resource_failure='ordinary4GiB resource guard software bug')
        save();assert valid,str(evidence)
    print('PASS 18 discovery/source-handler groups; zero work lifecycles',flush=True)

if __name__=='__main__':main()
