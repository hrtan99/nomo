#!/usr/bin/env python3
"""Owned v2 corrupt-parent/lineage clones and one actual v1 non-upgrade check."""
import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import sqlite3
import tempfile

import work_chain_probe as chain
from normal_graph_identity import verify_cli


def field(record, name):
    return next(value['value'] for value in record['fields'] if value['name']==name)


def scalar(record, name, value):
    target=field(record,name)
    target['value']=str(value) if target['kind'] in ['int','uint'] else value


def native_work(record):
    found=[]
    def visit(value):
        if isinstance(value,dict):
            if value.get('kind')=='record':
                names={item['name'] for item in value['fields']}
                if names=={'format','phase','binding','body'}: found.append(value)
            for item in value.values(): visit(item)
        elif isinstance(value,list):
            for item in value: visit(item)
    visit(record);assert len(found)==1
    return found[0]


def clone(source,destination):
    destination.mkdir(parents=True)
    with sqlite3.connect((source/'state/edit.sqlite3').as_uri()+'?mode=ro',uri=True) as old:
        with sqlite3.connect(destination/'edit.sqlite3') as new: old.backup(new)


def mutate(state,name):
    child=name.startswith('child_')
    with sqlite3.connect(state/'edit.sqlite3') as connection:
        if not child:
            # Use the independently decoded key rather than assuming its tagged
            # spelling when removing the optional successor in this owned copy.
            for region,key in connection.execute('SELECT region,key_json FROM memory_entries WHERE region IN (?,?)',[chain.CHAIN,chain.JOURNAL]).fetchall():
                if chain.untag(json.loads(key))=='turn:2': connection.execute('DELETE FROM memory_entries WHERE region=? AND key_json=?',[region,key])
        region=chain.JOURNAL if name.startswith('journal_') else chain.CHAIN
        selected='turn:2' if child else 'turn:1'
        raw=next(row for row in connection.execute('SELECT region,path,key_json,value_json FROM memory_entries WHERE region=?',[region]).fetchall() if chain.untag(json.loads(row[2]))==selected)
        value=json.loads(raw[3])
        if name=='parent_unknown': scalar(value,'phase','unknown')
        elif name=='parent_v1_format': scalar(value,'format',1)
        elif name=='parent_exhausted_corruption': scalar(field(value,'remaining'),'steps',0)
        elif name=='parent_workspace': scalar(value,'workspace','different-workspace')
        elif name=='parent_binding_digest': scalar(field(native_work(value),'binding'),'after_digest','a'*64)
        elif name=='journal_intent': scalar(value,'phase','intent')
        elif name=='journal_binding': scalar(field(value,'binding'),'request_digest','a'*64)
        elif name=='child_parent_version': scalar(value,'parent_version','different-opaque-token')
        elif name=='child_parent_digest': scalar(value,'parent_digest','a'*64)
        elif name=='child_wrong_turn': scalar(value,'turn',1)
        elif name=='child_remaining': scalar(field(value,'remaining'),'steps',1)
        elif name=='child_before_binding':
            work=native_work(value); fields=json.loads(field(work,'body')['value']);fields[25]='different original'
            field(work,'body')['value']=chain.work.cases.encoded(fields)
        elif name in ['journal_missing','parent_missing']:
            assert connection.execute('DELETE FROM memory_entries WHERE region=? AND path=? AND key_json=?',raw[:3]).rowcount==1
            return
        else: raise AssertionError(name)
        assert connection.execute('UPDATE memory_entries SET value_json=? WHERE region=? AND path=? AND key_json=?',
                                  [json.dumps(value,separators=(',',':')),*raw[:3]]).rowcount==1


def bad_show(cli,folder,state,selected,missing=False):
    args=['--id',selected['id'],'--workspace',selected['workspace'],'--path',selected['path']]
    argv=[cli,'run',folder/'show-project','--flow','chain_show','--profile','work-chain-show','--allow-effects','--trace-out',folder/'show.trace.json','--args',*args]
    before=chain.work.edit.previous.inspect(state)
    result=chain.process(folder,'show',argv,state,chain.saved.provider_free_environment())
    assert chain.work.edit.previous.inspect(state)==before
    actions=chain.trace_actions(folder,'show');assert set(actions)<={'Policy.evaluate','Memory.read','Console.stdout_write'}
    assert (result.returncode==0)==missing
    assert all(not line.partition(' ')[2].startswith('{') for line in result.stdout.decode().splitlines()), 'invalid chain exposed captured facts'
    assert (b'CHAIN missing' in result.stdout and b'no edit occurred' in result.stdout) if missing else b'REFUSED' in result.stdout
    return dict(command=list(map(str,argv)),exit=result.returncode,actions=actions,stdout=result.stdout.decode(),stderr=result.stderr.decode())


def corrupt(cli,evidence,source):
    observed=json.loads((source/'results.json').read_text());assert observed['status']=='passed' and 'second' in observed
    first=observed['first']['item'];second=observed['second']['item']
    assert observed['first']['phase']==observed['second']['phase']=='summary-confirmed'
    names=['parent_unknown','parent_v1_format','parent_exhausted_corruption','parent_workspace','parent_binding_digest',
           'journal_intent','journal_binding','journal_missing','parent_missing','child_parent_version','child_parent_digest',
           'child_wrong_turn','child_remaining','child_before_binding']
    results=[]
    for name in names:
        folder=evidence/name;state=folder/'state';clone(source,state);mutate(state,name)
        chain.profile_project(folder,state,source/'workspace',source/'context','project')
        chain.profile_project(folder,state,source/'workspace',source/'context','show-project',True)
        row=dict(name=name,status='running')
        if name=='parent_unknown': row['evidence_mode']='SQL-injected unsupported lifecycle phase; native WriteOutcome.Unknown was not injected'
        if name=='parent_exhausted_corruption': row['evidence_mode']='SQL-injected inconsistent first-turn remaining balance; actual two-turn exhaustion is covered by third-turn refusals'
        if not name.startswith('child_'):
            row['continue']=chain.refusal(cli,folder,state,folder/'project',second,'continue',parent='root-work')
        row['show']=bad_show(cli,folder,state,second if name.startswith('child_') else first,missing=name=='parent_missing')
        row['status']='passed';results.append(row);(folder/'results.json').write_text(json.dumps(row,indent=2)+'\n')
    return results


def v1_parent(cli,evidence):
    original=chain.work.edit.rows
    try:
        # One targeted old-route observation establishes that the v1 saved row
        # really exists; no synthetic v2 row can stand in for this evidence.
        chain.work.edit.rows=chain.ORIGINAL_ROWS
        selected=chain.work.cases.case('actual_v1_parent')
        old=chain.saved.run_case(cli,evidence,selected)
    finally: chain.work.edit.rows=original
    folder=evidence/'actual_v1_parent';state=folder/'state'
    next_input=chain.item('v1_parent_continue',turn=2)
    denied=chain.refusal(cli,folder,state,folder/'project',next_input,'v1-continue',parent=selected['id'])
    assert chain.CHAIN not in chain.rows(state) and chain.JOURNAL not in chain.rows(state)
    return dict(status='passed',actual_v1_save_show=old,**{'continue':denied})


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--source',type=Path,required=True,help='passed two-turn scenario directory from work_chain_probe')
    parser.add_argument('--include-v1',action='store_true');parser.add_argument('--prepare-only',action='store_true');args=parser.parse_args()
    args.evidence_dir.mkdir(parents=True,exist_ok=True);evidence=Path(tempfile.mkdtemp(prefix='work-chain-corrupt-',dir=args.evidence_dir));print('EVIDENCE '+str(evidence),flush=True)
    result=dict(task='WORK-CHAIN-001A-corruption',status='prepared',cases=[],v1=None);save=lambda:(evidence/'results.json').write_text(json.dumps(result,indent=2)+'\n');save()
    if args.prepare_only:return
    try:
        assert os.getuid()==10001;cli=verify_cli();result['status']='running';save()
        result['cases']=corrupt(cli,evidence,args.source.resolve());save();print('PASS '+str(len(result['cases']))+' corrupt parent/lineage cases',flush=True)
        if args.include_v1:result['v1']=v1_parent(cli,evidence);save();print('PASS actual_v1_parent_not_upgraded',flush=True)
        result['status']='passed'
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources']={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
        r=result['resources'];events=dict(line.split() for line in r['memory.events'].splitlines())
        valid=r['memory.max']=='4294967296' and r['cpu.max']=='400000 100000' and r['pids.max']=='256' and all(events[key]=='0' for key in ['max','oom','oom_kill','oom_group_kill'])
        if not valid:result.update(status='failed',resource_failure='ordinary resource guard failed')
        save();assert valid,str(evidence)


if __name__=='__main__':main()
