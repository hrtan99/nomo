#!/usr/bin/env python3
"""Independent parser/selection value component; original full18 stays BLOCKED."""
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
FIXTURE=ROOT/'tests/fixtures/session_discovery001/independent_values.es'
FULL_FIXTURE=ROOT/'tests/fixtures/session_discovery001/contract_probe.es'
FULL_RUNNER=ROOT/'tests/session_discovery_probe.py'
MODULES=TERMINAL_MODULES+['session/work_chain_journal_contract.es','session/work_chain_selection.es','cli/work_chain_selection_args.es']
BIND=['--workspace','owned','--path','target.txt']
LATEST=['continue','--latest','--id','child-op',*BIND,'--allow','context.txt']
EXPLICIT=['continue','--parent','root-op','--id','child-op',*BIND,'--allow','context.txt']
REQUEST='replace selected literal'
CAP='13,7,47104,196608,1,4096,3,6144,1,2048'

def cases():
    values=[]
    def add(label,*checks):values.append((label,' && '.join(checks)))
    def call(name,*args):return name+'('+', '.join(map(literal,args))+')'
    expected=['--id','child-op',*BIND,'--once',REQUEST,'--allow','context.txt','--parent','root-op']
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
    add('unresolved_latest_cannot_dispatch_until_bound',call('latest_bound',LATEST,'root-op',expected),call('latest_bound',LATEST+['--once',REQUEST],'root-op',expected),call('latest_bound',LATEST+['--cap',CAP],'root-op',expected+['--cap',CAP]),call('latest_bind_refused',LATEST,'child-op'),call('latest_bind_refused',EXPLICIT,'root-op'),call('once_missing',LATEST))
    add('highest_child_never_falls_back_to_root',*[call('selected',kind,'latest',['child-op']) for kind in ['child_admitted','child_partial','child_confirmed']],*[call('selection_refused',kind,'parent') for kind in ['child_admitted','child_partial','child_confirmed']],*[call('selected',kind,'root-op',['root-op']) for kind in ['child_admitted','child_partial','child_confirmed']],call('selected','child_confirmed','all',['root-op','child-op']))
    add('each_child_phase_preserves_captured_journal_meaning',call('latest_metadata','child_admitted','admitted','missing',False),call('latest_metadata','child_partial','summary-unconfirmed','completed',False),call('latest_metadata','child_confirmed','summary-confirmed','completed',False))
    add('unknown_id_and_explicit_binding_mismatch_refused',call('selection_refused','confirmed','missing-id'),call('binding_refused','foreign','target.txt'),call('binding_refused','owned','other.txt'))
    add('orphan_slots_and_journals_refuse_entire_selection',call('invalid_graph','child_confirmed','root_absent'),call('invalid_graph','confirmed','root_absent'),call('invalid_graph','confirmed','orphan_second_journal'),call('invalid_graph','child_confirmed','child_absent'))
    add('lineage_slot_and_journal_predicates_are_reused',*[call('invalid_graph','child_confirmed',mode) for mode in ['lineage','root_key','child_key']],*[call('invalid_graph','confirmed',mode) for mode in ['root_value','journal_key','journal_format','journal_chain','journal_phase','journal_absent']])
    add('independent_copied_intent_selection_only',call('latest_metadata','admitted_intent','admitted','intent',False),call('selection_refused','admitted_intent','parent'))
    add('independent_copied_root_selection_preconditions',call('selected','empty','all',[]),call('selected','empty','latest',[]),call('selection_refused','empty','parent'),call('latest_metadata','admitted','admitted','missing',False),call('latest_metadata','partial','summary-unconfirmed','completed',False),call('latest_metadata','confirmed','summary-confirmed','completed',True),call('selection_refused','admitted','parent'),call('selection_refused','partial','parent'),call('selected','confirmed','parent',['root-op']))
    add('independent_copied_snapshot_comparison_only',call('copied_comparison','child_confirmed','same',True),*[call('copied_comparison','child_confirmed',mode,False) for mode in ['root_version','child_version','journal_version','child_journal_version','root_absent','child_absent','journal_absent','child_journal_absent','root_value','journal_phase']],'copied_empty_presence()')
    assert len(values)==14 and len(values)==len({label for label,_ in values})
    return values

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir',type=Path,required=True);parser.add_argument('--prepare-only',action='store_true')
    args=parser.parse_args();checks=cases();args.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='session-discovery-values-PARTIAL-',dir=args.evidence_dir)).resolve()
    project=evidence/'project';(project/'src/app').mkdir(parents=True);sources={}
    print('EVIDENCE '+str(evidence),flush=True)
    for name in dict.fromkeys(MODULES):
        assert 'work_chain_observation' not in name and 'work_chain_store' not in name and 'work_chain_journal.es' not in name
        source=ROOT/'src/nomo'/name;target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        sources[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
    generated=FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join('Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks)+']')
    (project/'src/app/contract_probe.es').write_text(generated)
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','session-discovery-independent-values-PARTIAL'))
    record=dict(task='SESSION-DISCOVERY-001-independent-values-PARTIAL',status='prepared',checks=[label for label,_ in checks],sources=sources,commands=[],effect_proofs_passed=False,
        original_full18_status='OPEN/BLOCKED ETAS-0019; never replaced, reduced or accepted by this component result',
        preserved_full_sources={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in [FULL_FIXTURE,FULL_RUNNER]},
        execution_boundary=dict(Model_calls=0,work_admissions=0,work_lifecycles=0,product_File_Memory_operations=0,source_observation_handler_executed=False),
        qualification='Only existing pure parsers/selectors/journal predicates and copied-value consistency are exercised. Same original data-builder literal order, no handler/import/controller/store adapter. This does not qualify repeated real reads, negative handler refusal, persistence, execution or complete discovery/A18 acceptance.')
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(record,indent=2)+'\n');save()
    if args.prepare_only:return
    try:
        cli=verify_cli();count=len(list((project/'src').rglob('*.es')))
        commands=[('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),
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
            else:
                assert 'support: rejected[' not in item['stdout'],(label,'independent component support rejected',str(evidence))
                assert 'SessionObservation.capture' not in item['stdout']
                if label=='pure-effects':assert item['stdout'].count('requested actions: []')==item['stdout'].count('default actions: []')==1
                else:
                    assert item['stdout'].count('requested actions: [Console.stdout_write]')==item['stdout'].count('default actions: [Console.stdout_write]')==1
                    record['effect_proofs_passed']=True;save()
        record['status']='passed-component-only'
    except BaseException as error:record.update(status='failed-component',failure=repr(error));raise
    finally:
        record['resources'],valid=resources()
        if not valid:record.update(status='failed-component',resource_failure='ordinary4GiB resource guard software bug')
        save();assert valid,str(evidence)
    print('PASS 14 independent parser/selection value groups ONLY; original full18 remains BLOCKED',flush=True)

if __name__=='__main__':main()
