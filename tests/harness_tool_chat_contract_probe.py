#!/usr/bin/env python3
"""Synthetic pure defenses, not actual Console, model or filesystem execution."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

import harness_tool_contract_probe as previous
from normal_graph_identity import bootstrap_path, verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/harness_tool002a/contract_probe.es'
MODULES = previous.MODULES + ['harness/harness_tool_chat_contract.es']
encoded, record, ledger, observed, event, child = (previous.encoded, previous.record, previous.ledger,
                                                  previous.observed, previous.event, previous.child)
KEYS = ['steps', 'calls', 'tokens', 'tools', 'scan']
DEFAULT = [14, 8, 16384, 2, 8192]
DIRECT = [5, 3, 6144, 0, 0]
TOOL = [7, 4, 8192, 1, 4096]


def prior(**changes):
    value = dict(task='old-task', result='old-child', tool='read', outcome='complete: old-data', answer='old-parent')
    value.update(changes)
    return value, record('Previous', **{key: encoded(text) for key, text in value.items()})


def context(value=None):
    data = dict(phase='aggregate', request='Q', task='T', result='R', tool='read', outcome='complete: ',
                allowed=['a.txt'], prior=prior()[0]) if value is None else value
    return data, record('Context', **{key: prior(**item)[1] if key == 'prior' else encoded(item)
                                     for key, item in data.items()})


def seeded(value):
    rows = [dict(role='user', kind='context', name='original', text='Q')]
    if value['task']:
        rows += [dict(role='user', kind='context', name=name, text=value[name])
                 for name in ['task', 'result', 'tool', 'outcome', 'answer']]
    return rows


def events(rows):
    return [event(row['role'], row['kind'], row['name'], row['text']) for row in rows]


def invocation(usage=None, maximum=None, admitted=0, selected='empty()'):
    return record('Invocation', usage=usage or ledger(), maximum=maximum or ledger(*DEFAULT),
                  admitted=str(admitted), prior=selected)


def cases():
    values = []
    selected, selected_expr = prior()
    direct_prior = prior(tool='', outcome='')[1]
    empty_prior = prior(task='', result='', tool='', outcome='', answer='')[1]
    base = [event('user', 'context', 'original', 'Q'), event('user', 'input', text='T'), event('model', 'text', 'qwen')]
    final = event('assistant', 'final', text='CHILD')
    request = event('model', 'request', 'read', encoded(['read', 'a.txt']))
    complete = event('tool', 'complete', 'read', 'complete: ')
    error = event('error', 'error', text='bounded refusal')
    direct = child(base + [final])

    def add(label, mode='inspect', accepted=True, **changes):
        fields = dict(label=encoded(label), mode=encoded(mode), ledger=ledger(), usage=ledger(*DIRECT),
                      maximum=ledger(*DEFAULT), invocation='fresh_invocation()', prior=selected_expr,
                      context=context()[1], child=direct, legacy=direct, status='0', allowed='["a.txt"]',
                      accepted=str(accepted).lower(), expected_ledger=ledger(), expected_observed=observed())
        fields.update(changes)
        values.append((label, record('Check', **fields)))

    add('default_invocation', mode='defaults')
    add('default_admission', mode='admission')
    add('exact_single_turn_caps', mode='admission', maximum=ledger(*TOOL))
    for index, name in enumerate(KEYS):
        maximum = list(TOOL); maximum[index] -= 1
        add('narrow_first_' + name, mode='admission', accepted=False, maximum=ledger(*maximum))
        maximum = list(DEFAULT); maximum[index] -= 1
        add('narrow_remaining_' + name, mode='admission', accepted=False, ledger=ledger(*TOOL), maximum=ledger(*maximum))
    add('independent_cap_dimensions', mode='admission', ledger=ledger(*DIRECT), maximum=ledger(14, 8, 16000, 2, 8192))
    for label, first, usage, wanted in [('first_direct', [0]*5, DIRECT, DIRECT), ('first_tool', [0]*5, TOOL, TOOL),
                                     ('direct_direct', DIRECT, DIRECT, [10,6,12288,0,0]),
                                     ('direct_tool', DIRECT, TOOL, [12,7,14336,1,4096]),
                                     ('tool_direct', TOOL, DIRECT, [12,7,14336,1,4096]),
                                     ('tool_tool', TOOL, TOOL, DEFAULT),
                                     ('ordinary_failed_second', TOOL, [4,2,4096,1,4096], [11,6,12288,2,8192])]:
        add(label, mode='combine', ledger=ledger(*first), usage=ledger(*usage), expected_ledger=ledger(*wanted))
    add('exact_narrowed_compose', mode='combine', ledger=ledger(*DIRECT), usage=ledger(*TOOL),
        maximum=ledger(12,7,14336,1,4096), expected_ledger=ledger(12,7,14336,1,4096))
    for index, name in enumerate(KEYS):
        for number in [-1, 2147483647]:
            invalid = [0]*5; invalid[index] = number
            add('range_' + name + '_' + str(number), mode='invocation', accepted=False, ledger=ledger(*invalid))
    for label, usage in [('bad_token_relation',[5,3,6143,0,0]), ('bad_scan_relation',[7,4,8192,1,4095]),
                         ('too_many_boundaries',[5,0,0,0,0])]:
        add(label, mode='invocation', accepted=False, ledger=ledger(*usage))
    for label, usage in [('local_overflow',[2147483647,0,0,0,0]), ('local_step8',[8,4,8192,1,4096]),
                         ('local_tokens',[5,3,6143,0,0])]:
        add(label, mode='combine', accepted=False, usage=ledger(*usage))
    add('maximum_overflow', mode='admission', accepted=False, maximum=ledger(2147483647,8,16384,2,8192))
    add('maximum_negative', mode='admission', accepted=False, maximum=ledger(14,8,-1,2,8192))
    add('fresh_turn', mode='turn')
    add('second_direct_turn', mode='turn', invocation=invocation(ledger(*DIRECT), admitted=1, selected=direct_prior))
    add('second_tool_turn', mode='turn', invocation=invocation(ledger(*TOOL), admitted=1, selected=selected_expr))
    for label, supplied in [('refilled_second',invocation(admitted=1,selected=direct_prior)),
                            ('prior_on_first',invocation(selected=selected_expr)),
                            ('usage_on_first',invocation(ledger(*DIRECT))),
                            ('no_prior_second',invocation(ledger(*DIRECT),admitted=1)),
                            ('failed_usage_prior',invocation(ledger(3,2,4096),admitted=1,selected=direct_prior)),
                            ('tool_prior_direct_usage',invocation(ledger(*DIRECT),admitted=1,selected=selected_expr))]:
        add(label, mode='turn', accepted=False, invocation=supplied)
    for number in [-1,2,2147483647]:
        add('admitted_' + str(number), mode='turn', accepted=False, invocation=invocation(admitted=number))
    for label, supplied in [('empty',empty_prior), ('direct',direct_prior), ('read',selected_expr),
                            ('empty_complete',prior(outcome='complete: ')[1]),
                            ('maximum_fields',prior(task='T'*128,result='R'*256,outcome='complete: '+'x'*256,answer='A'*512)[1])]:
        add('prior_' + label, mode='prior', prior=supplied)
    for label, changes in [('partial_empty',dict(task='')), ('task129',dict(task='T'*129)),
                           ('result_empty',dict(result='')), ('result257',dict(result='R'*257)),
                           ('answer513',dict(answer='A'*513)), ('answer_control',dict(answer='a\nb')),
                           ('answer_blank',dict(answer=' ')), ('wrong_tool',dict(tool='command')),
                           ('outcome_without_tool',dict(tool='')), ('wrong_completion',dict(outcome='fake: data')),
                           ('outcome267',dict(outcome='complete: '+'x'*257))]:
        add('prior_' + label, mode='prior', accepted=False, prior=prior(**changes)[1])

    for quoted in [False, True]:
        for target in [2048,2049]:
            data = context()[0]
            fields = [(data['prior'],'answer',512),(data['prior'],'result',256),(data['prior'],'task',128),
                      (data['prior'],'outcome',266),(data,'request',128),(data,'task',128),(data,'result',256),(data,'outcome',266)]
            for owner, key, maximum in fields:
                while len(owner[key]) < maximum and len(encoded(data)) < target:
                    owner[key] += '"' if quoted and target-len(encoded(data)) >= 2 else 'x'
            assert len(encoded(data)) == target
            add(('quoted' if quoted else 'plain') + '_whole_context_' + str(target), mode='context',
                accepted=target==2048, context=context(data)[1])

    canonical = [('direct', [final], (1,1,2048,0,0), 0, observed('CHILD')),
                 ('first_protocol', [error], (1,1,2048,0,0), 3, observed()),
                 ('tool_refusal', [request,event('tool','error','read','refused: bounded')], (2,1,2048,1,4096), 3, observed()),
                 ('second_context', [request,complete,error], (2,1,2048,1,4096), 4, observed()),
                 ('one_tool', [request,complete,event('model','text','qwen'),final], (3,2,4096,1,4096), 0, observed('CHILD','read','complete: ')),
                 ('second_protocol', [request,complete,event('model','text','qwen'),error], (3,2,4096,1,4096), 3, observed())]
    selected_prefix = events(seeded(selected)) + base[1:]
    for label, tail, counts, status, wanted in canonical:
        add('project_' + label, mode='projection', child=child(selected_prefix+tail,*counts),
            legacy=child(base+tail,*counts), status=str(status), expected_observed=wanted)
        add('empty_prior_' + label, prior=empty_prior, child=child(base+tail,*counts), status=str(status), expected_observed=wanted)
    rows = seeded(selected)
    for index, key in enumerate(['task','result','tool','outcome','answer'],1):
        forged = deepcopy(rows); forged[index]['text'] += 'x'
        add('forged_prior_' + key, accepted=False, child=child(events(forged)+base[1:]+[final]))
    reordered=deepcopy(rows); reordered[1],reordered[2]=reordered[2],reordered[1]
    add('prior_order',accepted=False,child=child(events(reordered)+base[1:]+[final]))
    add('prior_characters',accepted=False,child='changed('+child(selected_prefix+[final])+', 0, false)')
    add('prior_stopped',accepted=False,child='changed('+child(selected_prefix+[final])+', 0, true)')
    add('canonical_final257',child=child(selected_prefix+[event('assistant','final',text='x'*257)]),expected_observed=observed('x'*257))
    add('failed_tool267',status='3',child=child(selected_prefix+[request,event('tool','error','read','truncated: '+'x'*256)],2,1,2048,1,4096))

    large = prior(task='"'*128,result='"'*256,outcome='complete: '+'"'*256,answer='A')[0]
    for count in range(1,513):
        large['answer']='"'*count
        history=seeded(large)+[dict(role='user',kind='input',name='',text='T')]
        raw=dict(history=history,allowed=['a.txt'],final_only=False)
        parent_context=context()[0]; parent_context.update(phase='plan',task='',result='',tool='',outcome='',prior=large)
        if len(encoded(raw))>2048 and len(encoded(parent_context))<=2048:break
    else:raise AssertionError('need a real child-only context overflow fixture')
    large_expr=prior(**large)[1]
    refusal=event('error','error',text='model context exceeds 2048 serialized characters')
    zero=child(events(history)+[refusal],0,0,0,0,0)
    add('zero_call_child_context_proven',mode='zero_proven',prior=large_expr,child=zero,status='4')
    add('zero_call_invalid_allowlist',accepted=False,prior=large_expr,child=zero,status='4',allowed='[]')
    add('zero_call_success',accepted=False,prior=large_expr,child=zero)
    add('zero_call_unproven_context',accepted=False,child=child(events(seeded(selected))+[base[1],refusal],0,0,0,0,0),status='4')
    add('zero_call_wrong_error',accepted=False,prior=large_expr,status='4',
        child=child(events(history)+[error],0,0,0,0,0))
    assert 0<len(values)<=128 and len(values)==len({label for label,_ in values})
    return values


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--etas',required=True,type=Path)
    parser.add_argument('--evidence-dir',required=True,type=Path)
    args=parser.parse_args()
    cli=verify_cli(); assert args.etas.is_absolute() and cli.resolve()==args.etas.resolve()
    evidence=Path(tempfile.mkdtemp(prefix='tool-chat-contract-',dir=args.evidence_dir)); project=evidence/'project'
    print('EVIDENCE '+str(evidence),flush=True)
    paths=[ROOT/'src/nomo'/name for name in MODULES]+[Path(__file__).resolve(),FIXTURE,Path(previous.__file__),
          ROOT/'tests/normal_graph_identity.py',bootstrap_path(),ROOT/'config/etas-latest-main.json',ROOT/'etas.lock']
    frozen={str(p.relative_to(ROOT)):digest(p) for p in paths}
    for source in paths:
        target=evidence/'inputs'/source.relative_to(ROOT); target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(source,target)
    for name in MODULES:
        target=project/'src/nomo'/name; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(ROOT/'src/nomo'/name,target)
    values=cases(); source=project/'src/app/contract_probe.es'; source.parent.mkdir(parents=True)
    source.write_text(FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(body for _,body in values)+']'))
    (project/'etas.toml').write_text('''[package]
name = "harness-tool-chat-contract-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "harness-tool-chat-contract-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.contract_probe"
flow = "observe"
profile = "fixture"
''')
    result=dict(scope='synthetic pure contract defenses; no actual Console/model/File claim',status='running',
                checks=[label for label,_ in values],inputs=frozen,identity=dict(executable=str(cli),sha256=digest(cli)),commands=[])
    output=evidence/'results.json'
    def save():output.write_text(json.dumps(result,indent=2)+'\n')
    save()
    try:
        for name,arguments in [('check',['check','--all',str(project)]),('pure-effects',['effects',str(project),'--flow','pure_probe']),
                               ('observe',['run',str(project),'--flow','observe','--allow-effects','--trace-out',str(evidence/'trace.json')])]:
            item=dict(label=name,command=[str(cli),*arguments],inputs={str(p.relative_to(project)):digest(p) for p in project.rglob('*') if p.is_file()})
            result['commands'].append(item); save()
            run=subprocess.run(item['command'],capture_output=True,timeout=180)
            for label,raw in [('stdout',run.stdout),('stderr',run.stderr)]:
                path=evidence/(name+'.'+label+'.bin');path.write_bytes(raw);item[label+'_sha256']=digest(path)
            item.update(exit=run.returncode,stdout=run.stdout.decode(),stderr=run.stderr.decode());save()
            assert run.returncode==0 and not run.stderr,item
            if name=='pure-effects':assert 'requested actions: []' in item['stdout'] and 'default actions: []' in item['stdout']
            if name=='observe':
                assert item['stdout'].splitlines()==['PASS '+label for label,_ in values]
                trace=json.loads((evidence/'trace.json').read_text())
                assert {e['qualified_action'] for e in trace['events'] if e['kind']=='host_request_started'}<={'Policy.evaluate','Console.stdout_write'}
        assert {str(p.relative_to(ROOT)):digest(p) for p in paths}==frozen
        result.update(status='passed',inputs_unchanged=True);save()
        print('PASS '+str(len(values))+' pure tool-chat checks; synthetic component only',flush=True)
    except BaseException as error:
        result.update(status='failed',failure=repr(error));save();raise


if __name__=='__main__':main()
