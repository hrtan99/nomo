#!/usr/bin/env python3
"""Seven returned-text pure contracts; creates no native v2 lifetime or store."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from model_protocol_probe import literal, resources
from harness_checkpoint_contract_probe import MANIFEST
from work_chain_contract_probe import MODULES as CHAIN_MODULES
from normal_graph_identity import verify_cli

ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/model_protocol002/contract_probe.es'
MODULES=CHAIN_MODULES+['session/work_chain_journal.es','entry/work_record_display.es','entry/work_chain_display.es']
PHASES=[('read-plan',384),('read-child-action',384),('read-child-final',1152),('read-aggregate',512),('edit-plan',4096),('edit-child',32768),('edit-aggregate',512)]


def encoded(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))


def cases():
    checks=[]
    def add(label,*expressions):checks.append((label,' && '.join(expressions)))
    def call(name,*values):return name+'('+', '.join(map(literal,values))+')'
    def denied(phase,raw):return call('refused',phase,raw)
    def diagnosed(phase,raw,category):
        maximum=dict(PHASES)[phase];size=str(len(raw.encode())) if len(raw)<=maximum else 'unmeasured'
        return call('diagnosed',phase,raw,'phase='+phase+' category='+category+' chars='+str(len(raw))+' utf8='+size)
    def plan(phase,task,raw=None):return call('plan',phase,encoded(['delegate',task]) if raw is None else raw,task)
    def action(raw,operation,files=(),text='',literal_text='',final=False,allowed=('a.txt','b.txt')):
        return call('action',raw,list(allowed),final,operation,list(files),literal_text,text)
    def edit(target,replacement,raw=None):return call('edit',encoded(['edit',target,replacement]) if raw is None else raw,target,replacement)
    def proposal(before,target,replacement,after='',accepted=False):return call('proposed',before,target,replacement,after,accepted)
    def snippet(raw,phase,required=(),forbidden=()):return call('snippet',raw,phase,dict(PHASES)[phase],list(required),list(forbidden))
    add('read_plan_structural_whitespace_and_exact_task',plan('read-plan','  Read "quoted" \\ path  ','\n[\t"delegate",\r"  Read \\"quoted\\" \\\\ path  "\n]\r'))
    add('read_plan_task128_and129',plan('read-plan','x'*128),diagnosed('read-plan',encoded(['delegate','x'*129]),'task'))
    add('read_plan_raw384_and385',plan('read-plan','x',' '*(384-len(encoded(['delegate','x'])))+encoded(['delegate','x'])),diagnosed('read-plan',' '*385,'limit'))
    add('read_plan_controls_unicode_and_extra_values',*[denied('read-plan',raw) for raw in ['["delegate","a\\n"]','["delegate","蓝"]','["delegate","x"] []','```["delegate","x"]```']])
    add('read_action_selected_read_and_search',action('["read","a.txt"]','read',['a.txt']),action('["search","find \\"q\\" \\\\ path","b.txt","a.txt"]','search',['b.txt','a.txt'],literal_text='find "q" \\ path'))
    read_raw='["read","a.txt"]'
    add('read_action_raw384_and385',action(' '*(384-len(read_raw))+read_raw,'read',['a.txt']),diagnosed('read-child-action',' '*(385-len(read_raw))+read_raw,'limit'))
    add('read_action_framing_stays_singleline',*[denied('read-child-action',raw) for raw in ['\n'+read_raw,'[\t"read","a.txt"]','["read",\r"a.txt"]']])
    add('read_action_no_direct_final_or_unselected_file',denied('read-child-action','["final","done"]'),denied('read-child-action','["read","outside.txt"]'),denied('read-child-action','["search","x","a.txt","a.txt"]'))
    add('read_action_path48_and49',action(encoded(['read','a'*48]),'read',['a'*48],allowed=['a'*48]),call('action_refused',encoded(['read','a'*49]),['a'*49],False))
    add('read_action_literal64_and65',action(encoded(['search','x'*64,'a.txt']),'search',['a.txt'],literal_text='x'*64),denied('read-child-action',encoded(['search','x'*65,'a.txt'])))
    add('read_action_field_shape_arity_and_malformed',*[denied('read-child-action',raw) for raw in ['["read",["a.txt"]]','["read",1]','["read"]','["read","a.txt","extra"]','["read" "a.txt"]',read_raw+' []']])
    add('read_action_escaped_controls_do_not_change_selection',denied('read-child-action',encoded(['read','a.txt\n'])),denied('read-child-action',encoded(['search','a\nb','a.txt'])))
    add('read_final_exact256_intersection',action(encoded(['final','x'*256]),'final',text='x'*256,final=True),denied('read-child-final',encoded(['final','x'*257])),denied('read-child-final',encoded(['final','x'*512])))
    final_raw=encoded(['final','answer'])
    escaped_final='"\\'*128
    add('read_final_decoded256_with_escape_overhead',action(encoded(['final',escaped_final]),'final',text=escaped_final,final=True))
    add('read_final_raw1152_and1153',action(' '*(1152-len(final_raw))+final_raw,'final',text='answer',final=True),diagnosed('read-child-final',' '*(1153-len(final_raw))+final_raw,'limit'))
    add('read_final_preserves_ascii_spaces_quotes_backslash',action(encoded(['final',' a "quote" \\ b ']),'final',text=' a "quote" \\ b ',final=True))
    add('read_final_no_controls_unicode_action_or_extra',*[denied('read-child-final',raw) for raw in [encoded(['final','a\nb']),encoded(['final','蓝']),encoded(['final',' ']),'["read","a.txt"]',final_raw+' []','["final",null]']])
    add('read_aggregate_ascii512_and513',call('issue','read-aggregate','x'*512)+' == ""',diagnosed('read-aggregate','x'*513,'limit'))
    add('read_aggregate_preserves_plain_text',call('issue','read-aggregate',' "quoted" \\ path ')+' == ""')
    add('read_aggregate_nonblank_singleline_ascii',*[denied('read-aggregate',raw) for raw in ['', ' ', 'x\n', '蓝', 'x\0']])
    special='Change "old" \\ path\nwith blue\r\n'
    add('edit_plan_escaped_line_endings_quotes_backslash',plan('edit-plan',special),plan('edit-plan',special,'\n[\t"delegate",'+encoded(special)+'\r]\n'))
    add('edit_plan_task512_bytes_and513',plan('edit-plan','é'*256),denied('edit-plan',encoded(['delegate','é'*256+'x'])),plan('edit-plan','x'*512),denied('edit-plan',encoded(['delegate','x'*513])))
    ep=encoded(['delegate','é'*256]);ep_bytes=len(ep.encode())
    add('edit_plan_raw4096_utf8_bytes_and4097',plan('edit-plan','é'*256,' '*(4096-ep_bytes)+ep),diagnosed('edit-plan',' '*(4097-ep_bytes)+ep,'limit'))
    add('edit_plan_empty_nul_task_or_wrong_field',*[denied('edit-plan',raw) for raw in [encoded(['delegate','']),encoded(['delegate',' ']),encoded(['delegate','a\0b']),'["delegate",1]','["edit","x"]']])
    add('edit_plan_framing_parse_arity_not_repaired',*[denied('edit-plan',raw) for raw in ['["delegate" "x"]','["delegate",["x"]]','["delegate","x","extra"]','["delegate","x"] []','```json\n["delegate","x"]\n```']])
    add('edit_child_preserves_literal_line_endings_quotes_backslash',edit('old\n"\\','blue\r\n"\\'),proposal('before old\n"\\ after','old\n"\\','blue\r\n"\\','before blue\r\n"\\ after',True))
    received_raw = '[\n  "edit",\n  "old\\\\n",\n  "blue\\\\n"\n]'
    add('received_edit_literal_backslash_n_is_not_file_lf',edit('old\\n','blue\\n',received_raw),proposal('old\n','old\\n','blue\\n'))
    add('edit_child_empty_replacement_allowed',edit('x',''),proposal('x','x','','',True))
    add('edit_child_target_replacement2048_utf8_bounds',edit('x'*2048,'é'*1024),denied('edit-child',encoded(['edit','x'*2049,'y'])),denied('edit-child',encoded(['edit','x','é'*1024+'x'])))
    add('edit_child_target_empty_and_nul_fields',*[denied('edit-child',raw) for raw in [encoded(['edit','','y']),encoded(['edit','a\0','y']),encoded(['edit','x','a\0'])]])
    ec=encoded(['edit','x','é'*1024]);ec_bytes=len(ec.encode())
    add('edit_child_raw32768_utf8_bytes_and32769',edit('x','é'*1024,' '*(32768-ec_bytes)+ec),diagnosed('edit-child',' '*(32769-ec_bytes)+ec,'limit'))
    add('edit_child_structural_whitespace_existing_contract',edit('x','y','\n[\t"edit",\r"x", "y"\n]\r'))
    add('edit_child_shape_arity_verb_parse_extra_refused',*[denied('edit-child',raw) for raw in ['["edit",["x"],"y"]','["edit","x"]','["edit","x","y","z"]','["write","x","y"]','["edit","x" "y"]','["edit","x","y"] []']])
    add('literal_target_missing_ambiguous_overlap_or_no_change',proposal('old','missing','y'),proposal('aaa','aa','y'),proposal('old','old','old'))
    add('literal_result2048_bytes_and2049',proposal('x','x','é'*1024,'é'*1024,True),proposal('ax','x','é'*1024))
    add('edit_aggregate_utf8_512_and513_bytes',call('issue','edit-aggregate','😀'*128)+' == ""',denied('edit-aggregate','😀'*128+'x'),call('issue','edit-aggregate','x'*512)+' == ""',denied('edit-aggregate','x'*513))
    add('edit_aggregate_preserves_nulfree_line_endings_and_quotes',call('issue','edit-aggregate','Done\n"quoted" \\ result\r\n')+' == ""')
    add('edit_aggregate_empty_blank_nul_refused',*[denied('edit-aggregate',raw) for raw in ['', ' ', '\n\t', 'a\0b']])
    add('diagnostic_read_action_categories',diagnosed('read-child-action','["write","a.txt"]','verb'),diagnosed('read-child-action','["read","outside.txt"]','files'))
    add('diagnostic_read_final_intersection_category',diagnosed('read-child-final',encoded(['final','x'*257]),'answer'))
    add('diagnostic_read_aggregate_categories',diagnosed('read-aggregate','x\n','control'),diagnosed('read-aggregate',' ','summary'))
    add('diagnostic_edit_plan_categories',*[diagnosed('edit-plan',raw,category) for raw,category in [('["edit","x"]','verb'),('["delegate",""]','task'),('["delegate",["x"]]','shape'),('["delegate"]','arity'),('["delegate" "x"]','json')]])
    add('diagnostic_edit_child_field_categories',diagnosed('edit-child',encoded(['edit','','x']),'target'),diagnosed('edit-child',encoded(['edit','x','a\0']),'replacement'))
    add('diagnostic_edit_aggregate_categories',diagnosed('edit-aggregate',' ','summary'),diagnosed('edit-aggregate','x'*513,'limit'))
    for phase,maximum in PHASES:
        raw='a\n"\\蓝😀';golden=r'["a\u000a\"\\\u84dd\ud83d\ude00"]';assert json.loads(golden)==[raw]
        expected='phase='+phase+' returned-text clipped=false redacted=false text='+golden
        add('diagnostic_'+phase+'_faithful_escaped_text',call('formatted',raw,phase,maximum,expected))
    add('diagnostic_all_phases_bounded_clipping',*[snippet('\x01'*80,phase,required=['clipped=true',r'\u0001'],forbidden=['\x01']) for phase,_ in PHASES])
    add('diagnostic_all_phases_secret_suppression_before_clip',*[snippet('x'*325+' aPi-KeY: fixture-secret',phase,required=['redacted=true'],forbidden=['xxxx','fixture-secret']) for phase,_ in PHASES])
    add('diagnostic_above_guard_omits_and_never_invents_utf8',*[call('response_error','x'*(maximum+1),phase,'limit',maximum)+' == '+literal('phase='+phase+' category=limit chars='+str(maximum+1)+' utf8=unmeasured') for phase,maximum in PHASES])
    add('legacy_read_plan_strict_error_unchanged',call('legacy_error','read-plan','[\n"delegate","x"]','expected bounded flat single-line delegation JSON'))
    add('legacy_edit_plan_child_errors_unchanged',call('legacy_error','edit-plan','["delegate"]','expected bounded flat delegation JSON'),call('legacy_error','edit-child','["write","x","y"]','unsupported edit verb or arity'))
    add('legacy_final512_remains_distinct_from_work256',call('legacy_final',encoded(['final','x'*512]),'x'*512),denied('read-child-final',encoded(['final','x'*512])))
    add('typed_postatomic_invalid_summary_retains_unconfirmed_and_show',*[call('post_atomic_failure',raw) for raw in ['', 'x'*513, 'a\0b']])
    assert len(checks)<=96 and len(checks)==len({label for label,_ in checks})
    return checks


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence-dir',type=Path,required=True);parser.add_argument('--prepare-only',action='store_true');options=parser.parse_args()
    checks=cases();options.evidence_dir.mkdir(parents=True,exist_ok=True);evidence=Path(tempfile.mkdtemp(prefix='model-protocol002-',dir=options.evidence_dir)).resolve();project=evidence/'project';(project/'src/app').mkdir(parents=True)
    print('EVIDENCE '+str(evidence),flush=True);sources={}
    for name in dict.fromkeys(MODULES):
        source=ROOT/'src/nomo'/name;target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);sources[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
    expressions=['Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','model-protocol002-contract-probe'))
    entry=(ROOT/'src/nomo/entry/work_chain_entry.es').read_text();ordered=[entry.index(value) for value in ['let saved = match publish_partial(ticket, candidate)','let summary = match summarize_chain(completed, prior','match complete(saved, summary.answer)']];assert ordered==sorted(ordered)
    result=dict(task='MODEL-PROTOCOL-002-pure',status='prepared',checks=[label for label,_ in checks],sources=sources,commands=[],
        lifetime_ledger=dict(actual_new_v2_admissions=0,maximum=2,reserved='both actual lifetimes reserved for real-Qwen diagnostic/final validation; this runner has no integration/admission mode'),
        postatomic_qualification='typed validated pending work/completed journal +pure display and source call-order; no actual atomic edit/store/admission; unchanged accepted prior actual failure evidence reused separately',source_publish_summary_complete_positions=ordered,
        source_fixture_encoding='reuse accepted local FF literal correction; exact decoded data and byte bounds remain semantic oracles')
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(result,indent=2)+'\n');save()
    if options.prepare_only:return
    try:
        cli=verify_cli();count=len(list((project/'src').rglob('*.es')))
        for label,argv,expected in [('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),('effects',[cli,'effects',project,'--flow','pure_probe'],None),('observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+label+'\n' for label,_ in checks))]:
            command=dict(label=label,command=list(map(str,argv)));result['commands'].append(command);save();observed=subprocess.run(command['command'],capture_output=True,timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            command.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save();assert observed.returncode==0 and not observed.stderr,command
            if expected is not None:assert command['stdout']==expected,command
            else:assert command['stdout'].count('requested actions: []')==command['stdout'].count('default actions: []')==1,command
        result['status']='passed'
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources'],valid=resources()
        if not valid:result.update(status='failed',resource_failure='ordinary resource guard software bug')
        save();assert valid,result
    print('PASS '+str(len(checks))+' grouped seven-boundary contracts; zero actual v2 admissions',flush=True)


if __name__=='__main__':main()
