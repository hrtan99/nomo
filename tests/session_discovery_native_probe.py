#!/usr/bin/env python3
"""One fresh session-discovery lifecycle through the supported host launcher.

Root alone executes this observer. It reuses the accepted scripted HTTP, PTY,
exact-owner cleanup and SQL observers; no old terminal matrix is invoked.
"""
import argparse
from copy import deepcopy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import traceback
import uuid

import terminal002_native_probe as terminal

trial, chain, ROOT = terminal.trial, terminal.chain, terminal.ROOT
TOKEN = 'session-discovery-scripted-synthetic-token'


def save(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n')


def ledger_change(path, operation):
    with os.fdopen(os.open(path, os.O_RDWR|os.O_NOFOLLOW), 'r+', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        value=json.load(stream);preserved={key:deepcopy(item) for key,item in value.items() if key!='A_discovery'}
        selected=value['A_discovery'];assert (selected['max_lifecycles'],selected['max_each'],selected['max_atomic'])==(2,28,4)
        operation(selected)
        assert {key:item for key,item in value.items() if key!='A_discovery'}==preserved
        stream.seek(0);stream.truncate();json.dump(value,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())


def reserve(path, evidence, review):
    identity=uuid.uuid4().hex
    def operation(value):
        previous=value['attempts']
        assert value['lifecycles_used']<2 and len(previous)<2
        assert not previous or (len(previous)==1 and previous[0]['status']=='failed' and review), 'only one concretely corrected, independently reviewed fresh lifecycle is available'
        assert not review or previous
        assert not any(item['status']=='reserved' for item in previous)
        reservation=dict(lifecycles=1,logical_starts=14,native_starts=14,HTTP_attempts=14,atomic_writes=2)
        assert all(item['reserved']==reservation for item in previous), 'prior reservation fields differ'
        for key in ('logical_starts','native_starts','HTTP_attempts','atomic_writes'):
            known=value[key];assert type(known) is int and known>=0
            reserved=sum(item['reserved'][key] for item in previous)
            ceiling=value['max_atomic'] if key=='atomic_writes' else value['max_each']
            assert max(reserved,known)+reservation[key]<=ceiling, 'cumulative '+key+' ceiling exceeded'
        value['lifecycles_used']+=1
        previous.append(dict(id=identity,status='reserved',evidence=str(evidence),correction_review=review,
            reserved=dict(lifecycles=1,logical_starts=14,native_starts=14,HTTP_attempts=14,atomic_writes=2)))
    ledger_change(path,operation);return identity


def charged(path, identity, record):
    def operation(value):
        attempt=next(item for item in value['attempts'] if item['id']==identity);assert attempt['status']=='reserved'
        steps=record.get('steps',[])
        exact=record.get('status')=='passed' and len(steps)==2 and all(item.get('counts',{}).get('exact_stage_proof') for item in steps)
        lower=dict(logical_starts=sum(item.get('counts',{}).get('logical_starts') or 0 for item in steps),
            native_starts=sum(max(item.get('lower_bounds',{}).get('trace_native_starts',0),item.get('lower_bounds',{}).get('HTTP_received',0)) for item in steps),
            HTTP_attempts=sum(item.get('lower_bounds',{}).get('HTTP_received',0) for item in steps),
            atomic_writes=sum(item.get('lower_bounds',{}).get('atomic_starts',0) for item in steps))
        observed=dict(logical_starts=14 if exact else None,native_starts=14 if exact else None,
            HTTP_attempts=14 if exact else None,atomic_writes=2 if exact else None)
        attempt.update(status=record['status'],observed=observed,known_lower_bounds=lower,failure=record.get('failure'),
            qualification='Full14/14/14/2 reservation retained. Exact logical/native/HTTP totals require complete traces, settled observers and exact stage/context match; wire count alone is not proof.')
        for key in lower:value[key]+=observed[key] if observed[key] is not None else lower[key]
        if not exact:value.setdefault('unproven_counts',[]).append(identity)
        record['ledger_observation']=dict(exact=observed,known_lower_bounds=lower)
    ledger_change(path,operation)


class OnceStep(terminal.Driver):
    def __init__(self, turn, folder, directory, record):
        super().__init__('B3',folder,directory,record)
        self.selected=trial.item(turn);self.binding,self.preview=chain.work.edit.expected(self.selected)
        self.trace_name='trace-discovery-turn-'+str(turn)+'.json'
    def commands(self):
        turn=self.selected['turn']
        args=['new','--id',trial.ROOT_ID,'--child-id',trial.CHILD_ID] if turn==1 else ['continue','--latest','--id',trial.CHILD_ID]
        return [str(trial.LAUNCH),'terminal',str(self.directory),*args,'--workspace',trial.WORKSPACE,'--path',trial.TARGET,
                '--allow',trial.CONTEXT,'--once',self.selected['request']]
    def drive_pty(self):
        assert terminal.REQUEST_PROMPT not in self.out+self.err, 'once mode unexpectedly requested another outer line'
        super().drive_pty()
    def run(self):
        original=trial.environment
        def environment(directory=None, trace=None, model=False):
            return original(directory,self.trace_name if trace=='trace-terminal002.json' else trace,model)
        trial.environment=environment
        try:return super().run()
        finally:trial.environment=original


def step(evidence, directory, turn, parent, record):
    folder=evidence/('turn-'+str(turn));folder.mkdir()
    selected=trial.item(turn);binding,_=chain.work.edit.expected(selected)
    current=dict(turn=turn,status='running')
    if parent is not None:current['first_parent']=deepcopy(parent)
    record['steps'].append(current)
    driver=OnceStep(turn,folder,directory,current);errors=[]
    try:driver.start_server();driver.run()
    except BaseException:errors.append(traceback.format_exc())
    finally:errors.extend(driver.cleanup())
    trace=terminal.trace_observation(directory,driver.trace_name);current['trace']=trace
    actions=trace.get('actions') or [];stable=current.get('HTTP_observer',{}).get('stable',False)
    native=sum(chain.work.model_action(action) for action in actions);wire=len(driver.all_requests)
    current['lower_bounds']=dict(trace_native_starts=native,HTTP_received=wire,atomic_starts=actions.count('Fs.atomic_replace'))
    proof=trace['complete'] and stable and native==wire==7
    if proof:
        try:chain.assert_http(selected,driver.all_requests,binding,chain.parent_facts(parent['value']) if parent else [])
        except (AssertionError,KeyError,TypeError,ValueError):proof=False
    current['counts']=dict(exact_stage_proof=proof,logical_starts=7 if proof else None,native_starts=7 if proof else None,
        HTTP_attempts=wire if stable else None,atomic_writes=actions.count('Fs.atomic_replace') if trace['complete'] and stable else None)
    try:
        assert current.get('owned_cleanup_confirmed') and stable and trace['complete'] and proof, 'owned cleanup, stable HTTP or exact stage trace is unproven'
        assert current['exit']==0 and driver.current_native and driver.current_nomo, 'both fresh confirmations and successful native result required'
        assert actions.count('Approval.request')==actions.count('Fs.atomic_replace')==actions.count('Console.stdin_read_line')==1
        assert actions.count('Memory.write')==5 and not any('SessionObservation.capture' in action for action in actions)
        rows=chain.rows(directory/'state');row=rows[chain.CHAIN]['turn:'+str(turn)]
        chain.assert_record(selected,row['value'],'summary-confirmed',binding)
        assert rows[chain.JOURNAL]['turn:'+str(turn)]['value']==dict(format=2,chain=trial.ROOT_ID,turn=turn,phase='completed',binding=binding)
        assert (directory/'workspace'/trial.TARGET).read_bytes()==selected['after'].encode()
        if parent is not None:assert rows[chain.CHAIN]['turn:1']==parent,'parent changed'
        sessions=[json.loads(line[8:]) for line in driver.out.decode().splitlines() if line.startswith('SESSION ')]
        assert [(value['phase'],value['current_id'],value['configured_turns_in_process']) for value in sessions]==[
            ('first' if turn==1 else 'second',selected['id'],'1'),('stopped',selected['id'],'0')]
        current.update(final_rows=rows,actual_file_after=selected['after'],status='passed')
    except BaseException:errors.append(traceback.format_exc())
    if errors:current.update(status='failed',failure='\n'.join(errors));raise AssertionError(current['failure'])
    return deepcopy(row)


def projection(evidence,directory,label,action,args,expected_ids,latest=None):
    before=chain.rows(directory/'state');snapshot=chain.work.edit.previous.inspect(directory/'state')
    result,record=trial.plain(evidence,label,action,directory,args,trace='trace-'+label+'.json')
    assert result.returncode==0,'provider-free projection failed'
    assert chain.rows(directory/'state')==before and chain.work.edit.previous.inspect(directory/'state')==snapshot
    trace=terminal.trace_observation(directory,'trace-'+label+'.json')
    assert trace['complete'] and set(trace['actions'])<={'Policy.evaluate','Memory.read','Console.stdout_write'}
    assert all(byte==10 or 32<=byte<=126 for byte in result.stdout)
    groups={}
    for line in result.stdout.decode().splitlines():
        prefix,_,value=line.partition(' ')
        if value.startswith('{'):groups.setdefault(prefix,[]).append(json.loads(value))
    if action=='sessions':
        observed=groups.get('SESSION',[]);assert [value['id'] for value in observed]==expected_ids
        for value in observed:
            row=next(item['value'] for item in before[chain.CHAIN].values() if item['value']['id']==value['id'])
            assert value['turn']==str(row['turn']) and value['phase']==row['phase'] and value['journal']=='completed'
            assert value['continuation_eligible']==('true' if len(expected_ids)==1 and row['turn']==1 else 'false')
            assert value['workspace']==trial.WORKSPACE and value['path']==trial.TARGET
    else:
        value=groups['CHAIN'][0];assert value['id']==latest and value['phase']=='summary-confirmed'
        selected=trial.item(1 if latest==trial.ROOT_ID else 2)
        assert groups['EDIT'][0]['before']==selected['before'] and groups['EDIT'][0]['after']==selected['after']
    record.update(trace=trace,groups=groups,application_rows_and_versions_unchanged=True)
    return record


def source_facts():
    paths=['etas.toml','etas.lock','compose.yaml','config/etas-latest-main.json','config/local-tryout-compose.yaml','config/local-tryout-model-compose.yaml','scripts/local-tryout.sh','scripts/terminal-transport.py','scripts/prepare-local-tryout.py',
        'src/nomo/cli/terminal_args.es','src/nomo/cli/work_chain_selection_args.es','src/nomo/session/work_chain_selection.es',
        'src/nomo/session/work_chain_observation.es','src/nomo/session/work_chain_store.es','src/nomo/entry/work_chain_sessions.es',
        'src/nomo/entry/terminal_entry.es']
    profile=tomllib.loads((ROOT/'etas.toml').read_text())['runtime']['profiles']['work-chain']
    assert profile['model']['retry']==dict(attempts=1,delay_ms=0)
    return dict(model=profile['model']['model'],HTTP_attempts_per_native_request=1,
        hashes={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in paths},
        qualification='Source/effective selected official compiler qualification belongs to root/TL. Actual native trace, received HTTP and application projections remain separate observations.')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--ledger',type=Path,required=True);parser.add_argument('--correction-review',default='')
    options=parser.parse_args();assert options.ledger.is_file()
    options.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='session-discovery-native-',dir=options.evidence_dir)).resolve()
    record=dict(task='SESSION-DISCOVERY-001',status='prepared',steps=[],projections=[],source=source_facts(),
        qualification='One new owned disposable lifecycle with local scripted HTTP only; not real Qwen, general discovery across arbitrary stores, or old trial replay.')
    print('EVIDENCE '+str(evidence),flush=True);output=evidence/'results.json';save(output,record)
    identity=reserve(options.ledger,evidence,options.correction_review);record.update(status='running',ledger_attempt=identity);save(output,record)
    chain.work.MODEL=record['source']['model'];chain.work.TOKEN=TOKEN
    try:
        directory=evidence/'fresh-fixture'
        prepared,record['prepare']=trial.plain(evidence,'prepare','prepare',directory);assert prepared.returncode==0
        assert chain.rows(directory/'state')=={} and (directory/'workspace'/trial.TARGET).read_bytes()==b'old\n'
        parent=step(evidence,directory,1,None,record);save(output,record)
        binding=['--workspace',trial.WORKSPACE,'--path',trial.TARGET]
        record['projections'].append(projection(evidence,directory,'root-sessions','sessions',binding,[trial.ROOT_ID]));save(output,record)
        record['projections'].append(projection(evidence,directory,'root-latest','show',['--latest',*binding],[trial.ROOT_ID],trial.ROOT_ID));save(output,record)
        step(evidence,directory,2,parent,record);save(output,record)
        record['projections'].append(projection(evidence,directory,'final-sessions','sessions',binding,[trial.ROOT_ID,trial.CHILD_ID]));save(output,record)
        record['projections'].append(projection(evidence,directory,'child-latest','show',['--latest',*binding],[trial.ROOT_ID,trial.CHILD_ID],trial.CHILD_ID));save(output,record)
        record['projections'].append(projection(evidence,directory,'explicit-root','show',['--id',trial.ROOT_ID,*binding],[trial.ROOT_ID,trial.CHILD_ID],trial.ROOT_ID))
        record['status']='passed'
    except BaseException:record.update(status='failed',failure=traceback.format_exc())
    finally:
        save(output,record)
        try:charged(options.ledger,identity,record)
        except BaseException:record.update(status='failed',ledger_update_failure=traceback.format_exc())
        save(output,record)
    print(record['status'].upper()+' '+str(output),flush=True)
    return 0 if record['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())
