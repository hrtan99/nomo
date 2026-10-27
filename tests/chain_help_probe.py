#!/usr/bin/env python3
"""Actual Console-only help/hint checks; shell output is parsed, never evaluated."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

from edit_contract_probe import literal, record
from harness_checkpoint_contract_probe import MANIFEST
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/local_tryout001/help_probe.es'
MODULES = ['core/text.es', 'core/conversation.es', 'tools/path_policy.es', 'session/edit_operation.es',
           'model/model_tool_contract.es', 'entry/work_chain_help.es']
FIRST = 'Replace old with the color from demo/context.txt'
SELECTORS = ["parent'$HOME; $(false) `printf NEVER`", 'owned "$HOME" && false', 'a/b.txt']


def cases():
    accepted = [('empty', ''), ('plain', 'plain'), ('apostrophe', "a'b"), ('double_quote', 'a"b'),
                ('spaces', ' spaced value '), ('dollar_substitution', '$(touch NEVER_EXECUTED)'),
                ('backticks', '`printf NEVER_EXECUTED`'), ('backslash', 'dir\\file'),
                ('shell_metacharacters', '; $HOME & | > < * ? [x] # !'), ('bound_128', 'a'*127+"'"),
                ('apostrophes_128', "'"*128), ('mixed_shell', "$(false) ' \" `false` \\ end")]
    rejected = [('oversize_129', 'a'*129), ('nul', '\0'), ('linefeed', 'a\nb'), ('carriage_return', 'a\rb'),
                ('tab', 'a\tb'), ('escape', '\x1b'), ('delete', '\x7f'), ('c1', '\x9b'),
                ('unicode', '前'), ('emoji', '😀'), ('bidi', '\u202e')]
    values = [dict(label=label, input=value, accepted=True, expected="'"+value.replace("'", "'\"'\"'")+"'") for label,value in accepted]
    values += [dict(label=label, input=value, accepted=False, expected='') for label,value in rejected]
    assert len(values) <= 32 and len({value['label'] for value in values}) == len(values)
    return values


def provider_free_environment():
    result = dict(os.environ)
    for name in list(result):
        if name.startswith(('ETAS_HOST_MODEL', 'ETAS_HOST_OMLX')) or name in ['NOMO_HARNESS_EDIT_TEST_KEY', 'NOMO_QWEN_SERVER_API_KEY', 'NOMO_GATEWAY_CLIENT_TOKEN']:
            result.pop(name)
    return result


def command_lines(stdout):
    return [line for line in stdout.splitlines() if line.startswith('./scripts/local-tryout.sh ')]


def validate_help_commands(stdout):
    lines = command_lines(stdout)
    expected = [
        ['./scripts/local-tryout.sh', 'prepare', '$NOMO_TRYOUT_DIR'],
        ['./scripts/local-tryout.sh', 'new', '$NOMO_TRYOUT_DIR', '--id', 'tryout-1', '--workspace', 'local-tryout', '--path', 'demo/value.txt', '--once', FIRST, '--allow', 'demo/context.txt'],
        ['./scripts/local-tryout.sh', 'show', '$NOMO_TRYOUT_DIR', '--id', 'tryout-1', '--workspace', 'local-tryout', '--path', 'demo/value.txt'],
        ['./scripts/local-tryout.sh', 'continue', '$NOMO_TRYOUT_DIR', '--parent', 'tryout-1', '--id', 'NEW_CHILD_ID', '--workspace', 'local-tryout', '--path', 'demo/value.txt', '--once', 'NEW_REQUEST', '--allow', 'demo/context.txt'],
    ]
    parsed = [shlex.split(line) for line in lines]
    assert parsed == expected, parsed
    assert all('"$NOMO_TRYOUT_DIR"' in line for line in lines)
    assert 'remaining allocation is a snapshot' in stdout and 'does not establish current second-slot availability' in stdout
    assert 'TEMPLATE only' in stdout and 'distinct new ID' in stdout
    assert '13,7,47104,196608,1,4096,3,6144,1,2048' in stdout
    assert '26,14,94208,393216,2,8192,6,12288,2,4096' in stdout
    return parsed


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--prepare-only',action='store_true');args=parser.parse_args()
    args.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='chain-help-',dir=args.evidence_dir));project=evidence/'project';(project/'src/app').mkdir(parents=True)
    checks=cases()
    for name in MODULES:
        target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/'src/nomo'/name,target)
    generated=FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(record('Check', item) for item in checks)+']')
    (project/'src/app/help_probe.es').write_text(generated)
    manifest=MANIFEST.replace('harness-checkpoint-contract-probe','chain-help-probe').replace('app.contract_probe','app.help_probe')
    (project/'etas.toml').write_text(manifest)
    result=dict(task='LOCAL-TRYOUT-001-help',status='prepared',checks=checks,commands=[],shell_execution=False)
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(result,indent=2)+'\n');save()
    print('EVIDENCE '+str(evidence),flush=True)
    if args.prepare_only:return
    env=provider_free_environment()
    def run(label, argv, success=True, trace=False):
        argv=list(map(str,argv));item=dict(label=label,command=argv);result['commands'].append(item);save()
        observed=subprocess.run(argv,cwd=project,env=env,capture_output=True,timeout=180)
        (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
        item.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save()
        diagnostic=dict(label=label,exit=observed.returncode,evidence=str(evidence))
        assert (observed.returncode==0)==success,diagnostic
        if success:assert not observed.stderr,diagnostic
        if trace:
            events=json.loads((evidence/(label+'.trace.json')).read_text())['events']
            actions=[event['qualified_action'] for event in events if event['kind']=='host_request_started']
            assert set(actions)<={'Policy.evaluate','Console.stdout_write'},(diagnostic,actions)
            item['actions']=actions;save()
        return item['stdout']
    try:
        assert os.getuid()==10001
        cli=verify_cli();result['status']='running';save()
        run('check',[cli,'check','--all',project])
        effects=run('pure-effects',[cli,'effects',project,'--flow','pure_probe'])
        assert effects.count('requested actions: []')==effects.count('default actions: []')==1
        for flow in ['emit_help','emit_hints']:
            effects=run(flow+'-effects',[cli,'effects',project,'--flow',flow])
            requested=next(line.strip() for line in effects.splitlines() if line.strip().startswith('requested actions:'))
            assert requested=='requested actions: [Console.stdout_write]',requested
        raw=run('quote-observe',[cli,'run',project,'--flow','observe','--allow-effects'])
        assert [line for line in raw.splitlines() if line.startswith('PASS ')]==['PASS '+value['label'] for value in checks]
        quoted={}
        for line in raw.splitlines():
            if line.startswith('QUOTED '):
                _,label,value=line.split(' ',2);assert label not in quoted;quoted[label]=value
        expected={value['label']:value for value in checks if value['accepted']}
        assert quoted.keys()==expected.keys()
        for label,value in quoted.items():
            assert value==expected[label]['expected']
            assert shlex.split(value)==[expected[label]['input']]
        result['native_quote_roundtrips']={label:dict(quoted=value,tokens=shlex.split(value)) for label,value in quoted.items()};save()
        for label,arguments in [('help-empty',[]),('help-flag',['--help']),('help-word',['help'])]:
            command=[cli,'run',project,'--flow','emit_help','--allow-effects','--trace-out',evidence/(label+'.trace.json')]
            if arguments:command+=['--args',*arguments]
            stdout=run(label,command,trace=True);assert all(byte==10 or 32<=byte<=126 for byte in stdout.encode())
            result[label+'-shell-tokens']=validate_help_commands(stdout);save()
        label='help-invalid'
        stdout=run(label,[cli,'run',project,'--flow','emit_help','--allow-effects','--trace-out',evidence/(label+'.trace.json'),'--args','unexpected'],success=False,trace=True)
        assert 'REFUSED chain_help' in stdout and [shlex.split(line) for line in command_lines(stdout)]==[['./scripts/local-tryout.sh','help']]
        label='hints'
        stdout=run(label,[cli,'run',project,'--flow','emit_hints','--allow-effects','--trace-out',evidence/(label+'.trace.json'),'--args',*SELECTORS],trace=True)
        commands=command_lines(stdout);parsed=[shlex.split(line) for line in commands]
        assert parsed==[
            ['./scripts/local-tryout.sh','show','$NOMO_TRYOUT_DIR','--id',SELECTORS[0],'--workspace',SELECTORS[1],'--path',SELECTORS[2]],
            ['./scripts/local-tryout.sh','continue','$NOMO_TRYOUT_DIR','--parent',SELECTORS[0],'--id','NEW_CHILD_ID','--workspace',SELECTORS[1],'--path',SELECTORS[2],'--once','NEW_REQUEST','--allow','a/b.txt,c/d.txt'],
            ['./scripts/local-tryout.sh','help'],['./scripts/local-tryout.sh','help']],parsed
        assert all('"$NOMO_TRYOUT_DIR"' in line for line in commands[:2])
        assert all(byte==10 or 32<=byte<=126 for byte in stdout.encode()) and 'invalid\nidentity' not in stdout and '../outside' not in stdout
        result['hint_shell_tokens']=parsed;result['status']='passed';save()
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources']={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
        r=result['resources'];events=dict(line.split() for line in r['memory.events'].splitlines())
        valid=r['memory.max']=='4294967296' and r['cpu.max']=='400000 100000' and r['pids.max']=='256' and all(events[key]=='0' for key in ['max','oom','oom_kill','oom_group_kill'])
        if not valid:result.update(status='failed',resource_failure='ordinary resource guard failed')
        save();assert valid,str(evidence)
    print('PASS '+str(len(checks))+' native quote checks; help/hints Console-only and shell tokens roundtrip without evaluation',flush=True)


if __name__=='__main__':main()
