#!/usr/bin/env python3
"""WORKSPACE-002A actual depth8 admission, deep read/edit/save and independent show.

Depth3..8 admission intentionally replaces the former depth2 refusal boundary.
All other total-length, lexical, file-count and content bounds stay unchanged.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from edit_contract_probe import record
from harness_checkpoint_contract_probe import MANIFEST
from harness_work_contract_probe import MODULES as WORK_MODULES
import harness_work_session_probe as saved
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/workspace002a/contract_probe.es'
READ48_A = 'a/'*7+'b'*34
READ48_B = 'a/'*7+'c'*34


def contracts():
    values = []
    def add(label, path, canonical, allowed=None):
        values.append(dict(label=label, path=path, canonical=canonical,
                           allowed=canonical and len(path)<=48 if allowed is None else allowed))
    for depth in range(1,9):
        add('components_'+str(depth)+'_accepted', '/'.join(['dir']*(depth-1)+['file.txt']), True)
    add('components_9_refused', '/'.join(['a']*8+['file.txt']), False)
    add('read_48_at_depth8_accepted', READ48_A, True)
    add('read_49_at_depth8_refused_edit_still_valid', READ48_A+'x', True, False)
    add('edit_128_at_depth8_accepted_read_refused', 'a/'*7+'b'*114, True, False)
    add('edit_129_at_depth8_refused', 'a/'*7+'b'*115, False)
    add('old_single_component_128_still_accepted', 'a'*128, True, False)
    add('old_two_components_128_still_accepted', 'a'*63+'/'+'b'*64, True, False)
    invalid = ['', '/root', 'a/', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a b', 'a:1', 'é', 'a/~b', 'a/"b', 'a/\t', 'a/'*7+'..', 'a/'*7+'.', 'a/'*7+'bad path']
    for number, path in enumerate(invalid): add('lexical_refusal_'+str(number), path, False)
    assert len(values) <= 64
    return values


def actual_cases():
    example = 'src/nomo/session/work_record.es'
    deep = 'a/b/c/d/e/f/g/input.txt'
    other = 'a/b/c/d/e/f/g/other.txt'
    return [saved.work.cases.case('nested_example_read', path=example, allowed=[example], context_files={example:'blue'}),
            saved.work.cases.case('depth8_search_two_files', path='a/b/c/d/e/f/g/edit.txt', operation='search', literal='CHOSEN', allowed=[deep, other],
                                  context_files={deep:'skip\nCHOSEN\n', other:'CHOSEN\n'}, read_reads=2),
            saved.work.cases.case('old_depth2_read', path='docs/edit.txt', allowed=['docs/context.txt'], context_files={'docs/context.txt':'blue'})]


def pure(cli, evidence, checks):
    project = evidence/'pure-project'; (project/'src/app').mkdir(parents=True)
    for name in [*WORK_MODULES, 'cli/edit_args.es']:
        target = project/'src/nomo'/name; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(ROOT/'src/nomo'/name,target)
    source = FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(record('Check', item) for item in checks)+']')
    source = source.replace('__READ48_A__',READ48_A).replace('__READ48_B__',READ48_B)
    (project/'src/app/contract_probe.es').write_text(source)
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','workspace-nested-probe'))
    commands=[]
    for label, argv in [('check',[cli,'check','--all',project]), ('effects',[cli,'effects',project,'--flow','pure_probe']), ('observe',[cli,'run',project,'--flow','observe','--allow-effects'])]:
        result=subprocess.run(list(map(str,argv)),capture_output=True,timeout=180)
        (evidence/(label+'.stdout.bin')).write_bytes(result.stdout); (evidence/(label+'.stderr.bin')).write_bytes(result.stderr)
        item=dict(label=label,argv=list(map(str,argv)),exit=result.returncode,stdout=result.stdout.decode(),stderr=result.stderr.decode());commands.append(item)
        (evidence/'pure-results.json').write_text(json.dumps(commands,indent=2)+'\n')
        assert result.returncode==0 and not result.stderr, (label,result.returncode,str(evidence))
        if label=='effects':
            assert item['stdout'].count('requested actions: []')==item['stdout'].count('default actions: []')==1
        if label=='observe': assert item['stdout']==''.join('PASS '+item['label']+'\n' for item in checks)+'PASS unchanged_file_count_and_allowance_bounds\n'
    return dict(status='passed',checks=len(checks)+1,commands=commands)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--suite',choices=['pure','runtime','all'],default='all');parser.add_argument('--prepare-only',action='store_true');options=parser.parse_args()
    options.evidence_dir.mkdir(parents=True,exist_ok=True);evidence=Path(tempfile.mkdtemp(prefix='workspace-nested-',dir=options.evidence_dir));print('EVIDENCE '+str(evidence),flush=True)
    checks=contracts();cases=actual_cases();(evidence/'cases.json').write_text(json.dumps(dict(pure=checks,actual=cases),indent=2)+'\n')
    if options.prepare_only:return
    result=dict(task='WORKSPACE-002A',status='running',pure=None,cases=[]);save=lambda:(evidence/'results.json').write_text(json.dumps(result,indent=2)+'\n');save()
    try:
        assert os.getuid()==10001;cli=verify_cli()
        if options.suite in ['pure','all']:
            result['pure']=pure(cli,evidence,checks);save();print('PASS '+str(result['pure']['checks'])+' pure path checks',flush=True)
        if options.suite in ['runtime','all']:
            for item in cases:
                result['cases'].append(saved.run_case(cli,evidence,item));save();print('PASS '+item['name'],flush=True)
        result['status']='passed'
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources']={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
        r=result['resources'];events=dict(line.split() for line in r['memory.events'].splitlines())
        valid=r['memory.max']=='4294967296' and r['cpu.max']=='400000 100000' and r['pids.max']=='256' and all(events[key]=='0' for key in ['max','oom','oom_kill','oom_group_kill'])
        if not valid:result.update(status='failed',resource_failure='ordinary resource guard failed')
        save();assert valid,str(evidence)


if __name__=='__main__':main()
