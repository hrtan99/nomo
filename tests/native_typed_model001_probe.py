#!/usr/bin/env python3
"""Source/effects and pure typed-contribution checks; no Model invocation mode."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from edit_contract_probe import literal
from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import resources
from normal_graph_identity import verify_cli

ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/native_typed_model001/contract_probe.es'
MODULES=['core/text.es','core/conversation.es','tools/path_policy.es','tools/edit_proposal.es','tools/edit_encoding.es',
         'session/edit_operation.es','model/model_tool_contract.es','harness/harness_model_contract.es',
         'harness/model_plan_diagnostic.es','harness/harness_tool_contract.es','harness/harness_edit_contract.es',
         'harness/harness_work_contract.es','tools/edit_contribution.es','harness/typed_edit_contract.es']


def cases():
    values=[]
    def add(label,*expressions):values.append((label,' && '.join(expressions)))
    def projected(original,target,replacement,after='',error='',path='notes/report.txt'):
        return 'projected('+', '.join(map(literal,[path,original,target,replacement,after,error]))+')'
    def contextual(before,target,replacement,phase='child',changed=False,after='',accepted=False):
        return 'contextual('+', '.join(map(literal,[before,target,replacement,phase,changed,after,accepted]))+')'
    add('unique_literal_preserves_caller_path_and_original',projected('prefix chosen suffix','chosen','updated','prefix updated suffix'))
    add('empty_replacement_is_data',projected('chosen','chosen','',''))
    add('absent_target_refused',projected('chosen','absent','updated',error='literal target not found'))
    add('ambiguous_nonoverlap_refused',projected('chosen chosen','chosen','updated',error='literal target is ambiguous'))
    add('overlapping_target_refused',projected('aaa','aa','updated',error='literal target is ambiguous'))
    add('unchanged_result_refused',projected('chosen','chosen','chosen',error='replacement leaves original unchanged'))
    add('empty_target_refused',projected('chosen','','updated',error='target must not be empty'))
    add('controller_path_still_validated',projected('chosen','chosen','updated',error='invalid relative path',path='../outside'))
    add('NUL_original_target_and_replacement_refused',projected('a\0b','a','x',error='original contains NUL'),projected('ab','a\0','x',error='target contains NUL'),projected('ab','a','x\0',error='replacement contains NUL'))
    add('original2048_UTF8_and2049',projected('é'*1024,'é'*1024,'updated','updated'),projected('é'*1024+'x','x','updated',error='original exceeds 2048 UTF-8 bytes'))
    add('target2048_UTF8_and2049',projected('é'*1024,'é'*1024,'x','x'),projected('x','é'*1024+'x','updated',error='target exceeds 2048 UTF-8 bytes'))
    add('replacement2048_UTF8_and2049',projected('x','x','😀'*512,'😀'*512),projected('x','x','😀'*512+'x',error='replacement exceeds 2048 UTF-8 bytes'))
    add('result2048_UTF8_and2049',projected('ax','x','é'*1023+'x','a'+'é'*1023+'x'),projected('ax','x','é'*1024,error='result exceeds 2048 UTF-8 bytes'))
    add('LF_surroundings_preserved',projected('head\nchosen\ntail\n','chosen','updated','head\nupdated\ntail\n'))
    add('CRLF_surroundings_preserved',projected('head\r\nchosen\r\ntail\r\n','chosen','updated','head\r\nupdated\r\ntail\r\n'))
    add('literal_backslash_n_surroundings_preserved',projected('head\\nchosen\\ntail\\n','chosen','updated','head\\nupdated\\ntail\\n'))
    add('literal_backslash_n_is_not_LF',projected('chosen\n','chosen\\n','updated\\n',error='literal target not found'))
    add('explicit_line_ending_change_allowed',projected('head\r\nchosen\r\ntail','chosen\r\n','updated\n','head\r\nupdated\ntail'))
    add('quotes_backslash_and_Unicode_are_literal',projected('head "雪😀" \\ path tail','"雪😀" \\ path','"雨" \\ new','head "雨" \\ new tail'))
    add('typed_child_context_projects_bound_data',contextual('head chosen tail','chosen','updated',after='head updated tail',accepted=True))
    add('nonchild_context_refused_without_inference',contextual('head chosen tail','chosen','updated',phase='plan'))
    add('changed_original_request_refused',contextual('head chosen tail','chosen','updated',changed=True))
    add('context_projection_reuses_ambiguity_and_change_guards',contextual('aaa','aa','updated'),contextual('chosen','chosen','chosen'))
    assert 0<len(values)<=32 and len(values)==len({label for label,_ in values})
    return values


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--prepare-only',action='store_true')
    options=parser.parse_args();checks=cases();options.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='native-typed-model001-',dir=options.evidence_dir)).resolve();project=evidence/'project';(project/'src/app').mkdir(parents=True)
    sources={}
    for name in MODULES:
        source=ROOT/'src/nomo'/name;target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);sources[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
    expressions=['Check { label = '+literal(label)+', passed = '+expression+' }' for label,expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__','['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','native-typed-model001-probe'))
    typed_project=evidence/'typed-project';(typed_project/'src/app').mkdir(parents=True)
    for name in MODULES+['harness/typed_edit_pilot.es']:
        source=ROOT/'src/nomo'/name;target=typed_project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        sources[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
    (typed_project/'src/app/contract_probe.es').write_text('module app.contract_probe;\nimport nomo.harness.harness_work_contract.Context;\nimport nomo.tools.edit_proposal.Proposal;\nimport nomo.harness.typed_edit_pilot.request_proposal;\npublic flow source_only(args: Array<string>) -> i32 { return 0; }\npublic flow typed_signature(supplied: Context) -> Result<Proposal, string> { return request_proposal(supplied); }\n')
    (typed_project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','native-typed-model001-static-probe').replace('flow = "observe"', 'flow = "source_only"'))
    isolated=['src/nomo/tools/edit_contribution.es','src/nomo/harness/typed_edit_contract.es','src/nomo/harness/typed_edit_pilot.es']
    for path in (ROOT/'src').rglob('*.es'):
        if str(path.relative_to(ROOT)) in isolated:continue
        text=path.read_text();assert 'nomo.harness.typed_edit_pilot' not in text and 'nomo.harness.typed_edit_contract' not in text and 'nomo.tools.edit_contribution' not in text
    result={'task':'NATIVE-TYPED-MODEL-001-source','status':'prepared','checks':[label for label,_ in checks],'sources':sources,'commands':[],
            'scope':'Typed signature/effects and pure contribution/content projection only; no full driver, Agent invocation or native work lifecycle',
            'actual_actions':{'Model':0,'provider':0,'File':0,'Memory':0,'Approval':0,'v2_admission':0,'durable_lifetime':0},
            'typed_signature':'Separate static-only project, never executed. Pure project excludes the Agent module entirely.',
            'pure_status':'prepared','typed_static':{'status':'prepared','project':str(typed_project)},
            'native_schema_backend_field_type_and_repair_execution':'unobserved; source signature does not establish backend enforcement or malformed-response behavior',
            'repair_policy':'No Etas/CLI no-repair setting established. This pilot body has exactly one explicit infer. Audited default max_tool_rounds8 permits up to9 native Host requests for that infer and up to9*A HTTP attempts for adapter retry attempts A. A general Agent body may contain multiple infer expressions, so this bound is not per arbitrary Agent call. No actual repair/usage is measured; this is not mapped into the existing seven-call v2 path.',
            'default_v2_entry_imports_pilot':False,
            'current_file_qualification':'Pure proposal binds supplied path/original; it is not current File observation, consent, receipt or persistence. Existing current-file validation remains unwired.',
            'fixture_literals':'Reuse established control/Unicode/backslash source adapter; semantic case inputs remain independent literals.'}
    output=evidence/'results.json';save=lambda:output.write_text(json.dumps(result,indent=2)+'\n');save();print('EVIDENCE '+str(evidence),flush=True)
    if options.prepare_only:return
    try:
        cli=verify_cli();count=len(list((project/'src').rglob('*.es')))
        commands=[('check',[cli,'check','--all',project],'checked '+str(count)+' files\n'),
                  ('pure-effects',[cli,'effects',project,'--flow','pure_probe'],None),
                  ('observe-effects',[cli,'effects',project,'--flow','observe'],None),
                  ('observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+label+'\n' for label,_ in checks))]
        for label,argv,expected in commands:
            item={'label':label,'command':list(map(str,argv))};result['commands'].append(item);save();observed=subprocess.run(item['command'],capture_output=True,timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save();assert observed.returncode==0 and not observed.stderr,item
            if expected is not None:assert item['stdout']==expected,item
            elif label=='pure-effects':assert item['stdout'].count('requested actions: []')==item['stdout'].count('default actions: []')==1,item
            else:
                assert 'Console.stdout_write' in item['stdout'] and not any(name in item['stdout'] for name in ('Agentic.','Fs.','Memory.','Approval.','Console.stdin')),item
        result['pure_status']='passed'
        typed_commands=[('typed-check',[cli,'check','--all',typed_project]),('typed-effects',[cli,'effects',typed_project,'--flow','typed_signature'])]
        for label,argv in typed_commands:
            item={'label':label,'command':list(map(str,argv))};result['commands'].append(item);save();observed=subprocess.run(item['command'],capture_output=True,timeout=240)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save()
            if observed.returncode!=0 or observed.stderr:
                result['typed_static'].update(status='blocked',diagnostics_label=label,qualification='Static diagnostics retained for owner/TL classification; no Model action or backend enforcement is exercised.')
                break
            if label=='typed-effects':
                assert 'Agentic.infer' in item['stdout'] and 'TypedEdit' in item['stdout'],item
                assert not any(name in item['stdout'] for name in ('Fs.','Memory.','Approval.','Console.')),item
                result['typed_static']['status']='passed'
        result['status']='passed' if result['typed_static']['status']=='passed' else 'pure-passed-typed-static-blocked'
    except BaseException as error:result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources'],valid=resources()
        if not valid:result.update(status='failed',resource_failure='ordinary4GiB resource guard software bug')
        save();assert valid,result
    print('PASS '+str(len(checks))+' grouped pure typed-contribution checks; typed static '+result['typed_static']['status']+'; zero Model/admission',flush=True)
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
