#!/usr/bin/env python3
"""Focused actual Etas v2 work-chain conservation and lineage contract checks."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from edit_contract_probe import literal
from harness_checkpoint_contract_probe import MANIFEST
from work_record_contract_probe import MODULES as WORK_MODULES
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/work_chain001/contract_probe.es'
MODULES = WORK_MODULES+['session/work_chain.es']


def cases():
    values=[]
    add=lambda name,checks: values.append((name,' && '.join(checks)))
    add('declared_two_turn_lifetime_before_work',['declared_lifetime()'])
    add('user_context_format_survives_publication_and_refuses_successor',['user_context_states()'])
    add('reservation_conserved_no_refund_after_summary',['conservation()'])
    add('parent_opaque_token_and_full_row_digest',['opaque_fingerprint()'])
    add('each_saved_dimension_shortage_refused',['shortage('+str(i)+', true)' for i in range(10)])
    add('each_current_policy_shortage_refused',['shortage('+str(i)+', false)' for i in range(10)])
    add('current_policy_cannot_raise_single_turn_limits',['over_policy('+str(i)+')' for i in range(10)])
    add('canonical_ten_counter_policy',['parse('+literal(raw)+', true)' for raw in ['13,7,47104,196608,1,4096,3,6144,1,2048','0,0,0,0,0,0,0,0,0,0']])
    add('noncanonical_or_unsupported_policy_refused',['parse('+literal(raw)+', false)' for raw in ['', '013,7,47104,196608,1,4096,3,6144,1,2048','13,7,47104,196608,1,4096,3,6144,1', '+13,7,47104,196608,1,4096,3,6144,1,2048','13,7,47104,196608,1,4096,3,6144,1,2049','26,14,94208,393216,2,8192,6,12288,2,4096','13,7,47104,196608,1,4096,3,6144,1, 2048','1'*129]])
    add('only_confirmed_v2_first_parent_can_continue',['parent_refused('+literal(mode)+')' for mode in ['admitted','partial','format','phase','work','third']])
    add('child_operation_id_must_differ',['repeated_id()'])
    add('root_metadata_lifetime_and_reservations_exact',['corrupt('+literal(mode)+')' for mode in ['format','phase','chain','turn','workspace','region','path','request','allowed','parent_id','parent_version','parent_digest','maximum','available','remaining','reserved','work']])
    add('child_parent_binding_and_whole_row_refs_exact',['child_corrupt('+literal(mode)+')' for mode in ['chain','workspace','region','path','allowed','parent_id','parent_version','parent_digest','maximum','available','remaining','reserved','work']])
    add('child_current_original_must_equal_parent_result',['original_changed()'])
    add('parent_opaque_utf8_bound_512',['token_bound('+literal('v'*512)+', true)','token_bound('+literal('v'*513)+', false)','token_bound('+literal('界'*171)+', false)','token_bound('+literal('')+', false)'])
    assert len(values)<=32
    return values


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir',type=Path,required=True);parser.add_argument('--prepare-only',action='store_true')
    args=parser.parse_args();checks=cases();args.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='work-chain-contract-',dir=args.evidence_dir));project=evidence/'project';(project/'src/app').mkdir(parents=True)
    for name in MODULES:
        target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/'src/nomo'/name,target)
    expressions=['Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','work-chain-contract-probe'))
    result=dict(task='WORK-CHAIN-001A-pure',status='prepared',checks=[name for name,_ in checks],commands=[]);output=evidence/'results.json'
    save=lambda:output.write_text(json.dumps(result,indent=2)+'\n');save();print('EVIDENCE '+str(evidence),flush=True)
    if args.prepare_only:return
    try:
        cli=verify_cli();count=len(list((project/'src').rglob('*.es')))
        for label,argv,expected in [('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),('effects',[cli,'effects',project,'--flow','pure_probe'],None),('observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+name+'\n' for name,_ in checks))]:
            item=dict(label=label,command=list(map(str,argv)));result['commands'].append(item);save()
            observed=subprocess.run(item['command'],capture_output=True,timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save()
            assert observed.returncode==0 and not observed.stderr,(label,observed.returncode,str(evidence))
            if expected is None:assert item['stdout'].count('requested actions: []')==item['stdout'].count('default actions: []')==1,str(evidence)
            else:assert item['stdout']==expected,(label,str(evidence))
        result['status']='passed'
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources']={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
        r=result['resources'];events=dict(line.split() for line in r['memory.events'].splitlines())
        valid=r['memory.max']=='4294967296' and r['cpu.max']=='400000 100000' and r['pids.max']=='256' and all(events[key]=='0' for key in ['max','oom','oom_kill','oom_group_kill'])
        if not valid:result.update(status='failed',resource_failure='ordinary resource guard failed')
        save();assert valid,str(evidence)
    print('PASS '+str(len(checks))+' pure chain groups',flush=True)

if __name__=='__main__':main()
