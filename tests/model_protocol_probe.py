#!/usr/bin/env python3
"""Focused read-plan contracts and deterministic native launcher observations.

Pure fixtures run inside the ordinary serial development container. The optional
--integration-host route runs on the host, supplies synthetic Model text, and
observes the actual launcher; neither mode establishes real-Qwen usability.
"""
import argparse
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

from edit_contract_probe import literal as established_literal
from harness_checkpoint_contract_probe import MANIFEST
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/model_protocol001/contract_probe.es'
MODULES = ['core/text.es', 'tools/edit_encoding.es', 'harness/harness_model_contract.es', 'harness/model_plan_diagnostic.es']
INVALID = '```json\n["delegate","lab-qwen-fixture-only-secret"]\n```'
SNIPPET_MARKER = 'phase=read-plan returned-text'


def literal(value):
    if isinstance(value,list):return '['+', '.join(literal(item) for item in value)+']'
    text=established_literal(value)
    # The frozen source lexer preserves JSON's short \f spelling as two
    # characters. Emit the actual FF scalar in this fixture's source; the
    # semantic input remains one character and its control refusal is unchanged.
    return text.replace('\\f','\x0c') if isinstance(value,str) else text


def cases():
    checks=[]
    def add(label,*expressions): checks.append((label,' && '.join(expressions)))
    def accept(raw,expected): return 'accepted('+literal(raw)+', '+literal(expected)+')'
    def refuse(raw): return 'refused('+literal(raw)+')'
    def diagnostic(raw,category):
        bytes_text=str(len(raw.encode())) if len(raw)<=384 else 'unmeasured'
        expected='phase=read-plan category='+category+' chars='+str(len(raw))+' utf8='+bytes_text
        return 'diagnosed('+literal(raw)+', '+literal(expected)+')'
    def old(raw,expected='',allowed=False): return 'legacy('+literal(raw)+', '+literal(expected)+', '+literal(allowed)+')'
    def snippet(raw,excluded='lab-qwen-',required=(),forbidden=()):
        return 'snippet('+', '.join(map(literal,[raw,excluded,list(required),list(forbidden)]))+')'
    plan=lambda task:json.dumps(['delegate',task],ensure_ascii=True,separators=(',',':'))
    add('singleline_and_standard_space',accept('["delegate","Read context"]','Read context'),accept(' [ "delegate" , "Read context" ] ','Read context'))
    add('external_json_tab_cr_lf',*[accept(space+'['+space+'"delegate"'+space+','+space+'"Read context"'+space+']'+space,'Read context') for space in ['\t','\r','\n',' \t\r\n']])
    add('pretty_json',accept('[\n  "delegate",\n  "Read context"\n]\n','Read context'))
    add('task_whitespace_is_preserved',accept(plan('  Read  context  '),'  Read  context  '))
    task='Read "literal" \\ path / with ,[]{} punctuation'
    add('task_json_escapes_are_decoded_once',accept(plan(task),task),accept('["delegate","\\u0052ead context"]','Read context'))
    add('task_ascii_127_128_bounds',*[accept(plan('t'*size),'t'*size) for size in [127,128]])
    add('task_ascii_129_refused',diagnostic(plan('t'*129),'task'))
    escaped_task='"\\'*64
    assert len(escaped_task)==128 and len(plan(escaped_task))<=384
    add('decoded_task_128_with_json_escape_overhead',accept(plan(escaped_task),escaped_task),diagnostic(plan(escaped_task+'x'),'task'))
    fixed=plan('t'*128)
    add('raw_383_384_admission',*[accept(' '*(size-len(fixed))+fixed,'t'*128) for size in [383,384]])
    add('raw_385_refused_without_repair',diagnostic(' '*(385-len(fixed))+fixed,'limit'))
    add('raw_limit_includes_outer_whitespace',diagnostic('\n'*385,'limit'))
    add('empty_raw_and_blank_task_refused',diagnostic('','limit'),*[diagnostic(plan(value),'task') for value in ['', ' ', '   ']])
    add('unicode_raw_character_and_utf8_metadata',diagnostic('["delegate","蓝😀"]','control'))
    add('unicode_escapes_do_not_extend_task_alphabet',diagnostic('["delegate","\\u84dd"]','task'),diagnostic('["delegate","\\ud83d\\ude00"]','task'))
    add('json_escaped_controls_refused_as_task',*[diagnostic(plan('a'+value+'b'),'task') for value in ['\n','\r','\t','\x00','\x1b','\x7f']])
    add('literal_controls_inside_string_refused',*[diagnostic('["delegate","a'+value+'b"]','control') for value in ['\n','\r','\t','\x00','\x1b','\x7f']])
    add('non_json_external_whitespace_refused',*[diagnostic(value+'["delegate","x"]','control') for value in ['\v','\f','\x00','\x1b','\x7f','\u00a0']])
    add('nested_arrays_objects_and_nonstring_fields_refused',*[diagnostic(raw,'shape') for raw in ['{}','["delegate",["x"]]','["delegate",{}]','["delegate",1]','["delegate",null]','["delegate",true]']])
    add('flat_array_arity_refused',*[diagnostic(raw,'arity') for raw in ['[]','["delegate"]','["delegate","x","extra"]']])
    add('unknown_or_case_changed_verb_refused',*[diagnostic(plan(value).replace('"delegate"','"'+verb+'"',1),'verb') for verb,value in [('edit','x'),('Delegate','x'),(' delegate','x')]])
    add('malformed_json_is_not_repaired',*[refuse(raw) for raw in ['["delegate" "x"]','["delegate",,"x"]','["delegate","x",]','["delegate","bad\\q"]','["delegate","\\uZZZZ"]']])
    add('json_category_metadata',diagnostic('["delegate" "x"]','json'))
    add('diagnostic_never_includes_returned_secret',diagnostic(INVALID,'frame'))
    add('fences_prose_and_trailing_values_refused',*[diagnostic(raw,'frame') for raw in ['```json\n["delegate","x"]\n```','Here is ["delegate","x"]','["delegate","x"] extra','["delegate","x"] []','["delegate","x"] ["delegate","y"]']])
    add('incomplete_arrays_and_strings_refused',*[refuse(raw) for raw in ['[','["delegate","x"','["delegate","x]','["delegate","x\\']])
    add('legacy_singleline_task_preserved',old(plan(' a  b '),' a  b ',True))
    add('legacy_external_controls_stay_strict',*[old(raw) for raw in ['\n["delegate","x"]','[\n"delegate","x"]','\t["delegate","x"]']])
    add('legacy_task_and_raw_bounds_stay_strict',old(plan('x'*129)),old(' '*385+plan('x')))
    # Formatter checks below are populated from its explicit stable metadata
    # contract, while decoder checks above assert semantic wire decisions.
    add('snippet_ascii_no_control_or_unicode_leak',snippet('a\tb\r\n\x00"\\蓝😀',required=['clipped=false'],forbidden=['\t','\r','\n','\x00','蓝','😀']))
    escaped_raw='a\tb\r\n\x00"\\蓝😀'
    escaped_json=r'["a\u0009b\u000d\u000a\u0000\"\\\u84dd\ud83d\ude00"]'
    assert json.loads(escaped_json)==[escaped_raw]
    expected='phase=read-plan returned-text clipped=false redacted=false text='+escaped_json
    add('snippet_faithful_ascii_json_escaping','exact_snippet('+', '.join(map(literal,[escaped_raw,'lab-qwen-',expected]))+')')
    add('snippet_encoded_expansion_is_clipped',snippet('\x01'*60,required=['clipped=true',r'\u0001'],forbidden=[r'\u0001'*54]))
    add('snippet_clipping_explicit_and_bounded',snippet('x'*600,required=['clipped=true'],forbidden=['x'*384]))
    add('snippet_excluded_prefix_redacts_all',snippet('before lab-qwen-fixture-only-secret after','lab-qwen-',required=['redacted=true'],forbidden=['before','lab-qwen-','fixture-only-secret','after']))
    add('snippet_key_after_clip_still_redacts_all',snippet('x'*600+'lab-qwen-fixture-only-secret','lab-qwen-',required=['redacted=true'],forbidden=['xxxx','lab-qwen-','fixture-only-secret']))
    add('snippet_authorization_markers_redact_all',*[snippet(value,required=['redacted=true'],forbidden=['fixture-only-secret']) for value in ['Bearer fixture-only-secret','Authorization: fixture-only-secret']])
    add('snippet_mixedcase_authorization_redacts_all',snippet('before aUtHoRiZaTiOn: fixture-only-secret after',required=['redacted=true','clipped=false','<redacted>'],forbidden=['before','aUtHoRiZaTiOn','fixture-only-secret','after']))
    late_header='x'*325+' aPi-KeY: fixture-only-secret'
    assert len(late_header)<=384
    add('snippet_mixedcase_api_key_after_clip_redacts_all',snippet(late_header,required=['redacted=true','clipped=false','<redacted>'],forbidden=['xxxx','aPi-KeY','fixture-only-secret']))
    add('empty_exclusion_fails_closed',snippet('ordinary fixture text',excluded='',required=['redacted=true','clipped=false'],forbidden=['ordinary fixture text']))
    assert 0<len(checks)<=64 and len(checks)==len({label for label,_ in checks})
    return checks


def resources():
    value={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
    events=dict(line.split() for line in value['memory.events'].splitlines())
    valid=value['memory.max']=='4294967296' and value['cpu.max']=='400000 100000' and value['pids.max']=='256' and all(events[name]=='0' for name in ['max','oom','oom_kill','oom_group_kill'])
    return value,valid


def pure(evidence,prepare_only):
    checks=cases();project=evidence/'project';(project/'src/app').mkdir(parents=True)
    sources={}
    for name in MODULES:
        source=ROOT/'src/nomo'/name;target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        sources[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
    expressions=['Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks]
    generated=FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(expressions)+']')
    (project/'src/app/contract_probe.es').write_text(generated)
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','model-protocol-contract-probe'))
    result=dict(task='MODEL-PROTOCOL-001-pure',status='prepared',checks=[label for label,_ in checks],sources=sources,commands=[],source_fixture_encoding='local FF source literal emits actual scalar U+000C; frozen lexer preserves short JSON backslash-f as two characters; semantic input/refusal unchanged; failed first package and six-case actual diagnostic retained',oversized_utf8='explicitly unmeasured above raw384 guard; never an invented byte count',qualification='native pure semantic contract evidence only; no actual Provider response or live lifetime')
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(result,indent=2)+'\n');save()
    if prepare_only:return
    try:
        cli=verify_cli();count=len(list((project/'src').rglob('*.es')))
        commands=[('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),('effects',[cli,'effects',project,'--flow','pure_probe'],None),('observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+label+'\n' for label,_ in checks))]
        for label,argv,expected in commands:
            command=dict(label=label,command=list(map(str,argv)));result['commands'].append(command);save()
            observed=subprocess.run(command['command'],capture_output=True,timeout=180)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            command.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save()
            assert observed.returncode==0 and not observed.stderr,command
            if expected is not None:assert command['stdout']==expected,command
            else:assert command['stdout'].count('requested actions: []')==command['stdout'].count('default actions: []')==1,command
        result['status']='passed'
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources'],valid=resources()
        if not valid:result.update(status='failed',resource_failure='ordinary resource guard software bug')
        save();assert valid,result
    print('PASS '+str(len(checks))+' grouped native pure model protocol checks',flush=True)


def integration(evidence):
    import local_tryout_probe as trial
    chain=trial.chain
    original_reply=chain.reply
    def reply(selected,context,ordinal):
        assert selected['protocol_invalid'] and ordinal==0
        return INVALID
    chain.reply=reply
    record=dict(task='MODEL-PROTOCOL-001-native-deterministic',status='running',
        qualification='one run-once synthetic invalid Model result through actual launcher/native Host; not real-Qwen wire evidence; no automatic retry',
        lifetime_ledger=dict(maximum_new_v2_lifetimes=2,lifetime_1='this deterministic invalid inspection fixture; admission consumes it even on failure',lifetime_2='reserved for the separately authorized final real-Qwen two-turn validation; not executed by this runner'),
        default_snippet_absence='source call-guard observation only; no second native fixture',
        old_singleline_success='covered by native pure decoder contracts; no additional v2 fixture')
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(record,indent=2)+'\n');save()
    try:
        tools=(ROOT/'src/nomo/harness/harness_model_tools.es').read_text()
        assert 'if inspect_plan { println(returned_text(raw, "lab-qwen-")); }' in tools
        folder=evidence/'inspection-invalid';folder.mkdir();directory=folder/'tryout'
        prepared,setup=trial.plain(folder,'prepare','prepare',directory);assert prepared.returncode==0,setup
        selected=trial.item(1);selected.update(protocol_invalid=True,calls=1,atomic=0,exit_zero=False)
        state=directory/'state';server=ThreadingHTTPServer(('127.0.0.1',trial.PORT),trial.CoLocatedHandler);server.daemon_threads=True
        server.item,server.state,server.records,server.lock,server.partial=selected,state,[],threading.Lock(),None
        thread=threading.Thread(target=server.serve_forever,kwargs=dict(poll_interval=0.01),daemon=True);thread.start()
        result=dict(status='running',action='inspect-new');record['inspection_invalid']=result
        try:
            trace='trace-inspection-invalid.json'
            native,observed=trial.plain(folder,'apply','inspect-new',directory,trial.request_arguments(selected),model=True,trace=trace);result.update(observed)
            assert native.returncode!=0 and b'REFUSED' in native.stdout
            expected='phase=read-plan category=frame chars='+str(len(INVALID))+' utf8='+str(len(INVALID.encode()))
            assert expected.encode() in native.stdout
            assert b'Type `yes` to approve:' not in native.stdout+native.stderr and chain.work.edit.PROMPT not in native.stdout+native.stderr
            recorded=trial.actions(directory,trace)
            assert recorded.count('Memory.write')==1 and sum(chain.work.model_action(value) for value in recorded)==1
            assert {value for value in recorded if not chain.work.model_action(value)}<={'Policy.evaluate','Memory.read','Memory.write','Console.stdout_write'},recorded
            assert not any(value.startswith(('Fs.','Approval.')) for value in recorded)
            assert (directory/'workspace'/trial.TARGET).read_bytes()==b'old\n'
            rows=chain.rows(state);assert set(rows)=={chain.CHAIN} and set(rows[chain.CHAIN])=={'turn:1'}
            binding,_=chain.work.edit.expected(selected);chain.assert_record(selected,rows[chain.CHAIN]['turn:1']['value'],'admitted',binding)
            chain.assert_http(selected,server.records,binding,[])
            expected_snippet=SNIPPET_MARKER+' clipped=false redacted=true text=["<redacted>"]'
            assert expected_snippet.encode() in native.stdout
            assert b'lab-qwen-fixture-only-secret' not in native.stdout+native.stderr
            result.update(status='passed',rows=rows,actions=recorded)
        except BaseException as error:result.update(status='failed',failure=repr(error));raise
        finally:
            server.shutdown();thread.join(timeout=2)
            for request in server.records:request['finished'].wait(2)
            server.server_close();result['http']=[{key:value for key,value in request.items() if key!='finished'} for request in server.records]
            (folder/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
        result['show']=trial.show(folder,directory,selected,'show-failed','admitted',6,None)
        record['status']='passed'
    except BaseException as error:record.update(status='failed',failure=repr(error));raise
    finally:chain.reply=original_reply;save()
    print('PASS one actual invalid read-plan inspection lifetime and provider-free failed show',flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--prepare-only',action='store_true');parser.add_argument('--integration-host',action='store_true');options=parser.parse_args()
    assert not(options.prepare_only and options.integration_host),'prepare-only applies to pure fixture generation'
    options.evidence_dir.mkdir(parents=True,exist_ok=True);evidence=Path(tempfile.mkdtemp(prefix='model-protocol-',dir=options.evidence_dir)).resolve()
    print('EVIDENCE '+str(evidence),flush=True)
    if options.integration_host:integration(evidence)
    else:pure(evidence,options.prepare_only)


if __name__=='__main__':main()
