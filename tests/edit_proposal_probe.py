#!/usr/bin/env python3
"""Bounded actual Etas edit checks; no filesystem edit operation is exercised."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

import harness_checkpoint_contract_probe as helper
from session_lifecycle_contract_probe import literal as balanced_literal
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/tool002a/proposal_probe.es'
MODULES = ['tools/path_policy.es', 'tools/edit_proposal.es']


def literal(value):
    # The accepted lexer permits literal NUL inside a quoted string; its source
    # unquoter does not interpret JSON's six-character \\u0000 spelling.
    return balanced_literal(value).replace('\\u0000', '\x00')


def cases():
    values = []
    def add(label, original='left old right', target='old', replacement='new', after='left new right',
            *, path='docs/file.txt', error='', mode='propose', forged=None):
        request = dict(path=path, original=original, target=target, replacement=replacement)
        expected = dict(path=path, before=original, after=after)
        if forged: expected.update(forged)
        values.append(dict(label=label, mode=mode, request=request, expected=expected, error=error))
    add('beginning', 'old tail', 'old', 'new', 'new tail')
    add('middle')
    add('end', 'head old', 'old', 'new', 'head new')
    add('delete_middle', 'leftXright', 'X', '', 'leftright')
    add('delete_entire_file', 'old', 'old', '', '')
    add('spaces_preserved', '  old  ', 'old', ' new ', '   new   ')
    add('literal_not_regex', 'a.*b', '.*', '$&', 'a$&b')
    add('replacement_not_researched', 'old', 'old', 'old old', 'old old')
    add('backslashes_quotes_literal', 'a\\n"old"b', 'old', '\\1"', 'a\\n"\\1""b')
    add('unicode_boundaries', '前😀old後', 'old', '世界', '前😀世界後')
    add('unicode_not_normalized', 'é é', 'é', 'X', 'X é')
    add('line_endings_tabs_preserved', 'a\r\nold\t\nb\r', 'old', 'N\r\n', 'a\r\nN\r\n\t\nb\r')
    add('nul_original_refused', '\x00old', 'old', 'new', '', error='original contains NUL')
    add('nul_target_refused', 'abc', '\x00', 'x', '', error='target contains NUL')
    add('nul_replacement_refused', 'old', 'old', 'n\x00', '', error='replacement contains NUL')
    add('nul_fixture_representation', '\x00', '\x00', 'x', 'x', mode='encoding')
    add('empty_target', error='target must not be empty', target='')
    add('empty_original', '', 'x', 'y', '', error='literal target not found')
    add('missing', 'abc', 'ABC', 'x', '', error='literal target not found')
    add('multiple', 'old old', 'old', 'x', '', error='literal target is ambiguous')
    add('overlap_aa', 'aaa', 'aa', 'x', '', error='literal target is ambiguous')
    add('overlap_aba', 'ababa', 'aba', 'x', '', error='literal target is ambiguous')
    add('overlap_unicode', 'ééé', 'éé', 'x', '', error='literal target is ambiguous')
    add('noop', replacement='old', error='replacement leaves original unchanged')
    add('original_ascii_2048', 'A'+'x'*2047, 'A', 'B', 'B'+'x'*2047)
    add('original_ascii_2049', 'A'+'x'*2048, 'A', 'B', '', error='original exceeds 2048 UTF-8 bytes')
    add('target_2048', 'q'*2048, 'q'*2048, 'Z', 'Z')
    add('target_2049', 'abc', 'q'*2049, 'Z', '', error='target exceeds 2048 UTF-8 bytes')
    add('replacement_2048', 'A', 'A', 'x'*2048, 'x'*2048)
    add('replacement_2049', 'A', 'A', 'x'*2049, '', error='replacement exceeds 2048 UTF-8 bytes')
    add('result_2048', 'Ab', 'A', 'x'*2047, 'x'*2047+'b')
    add('result_2049', 'Ab', 'A', 'x'*2048, '', error='result exceeds 2048 UTF-8 bytes')
    add('unicode_original_2048_bytes', 'é'*1024, 'é'*1024, 'Z', 'Z')
    add('unicode_original_2049_bytes', 'é'*1024+'x', 'x', 'Z', '', error='original exceeds 2048 UTF-8 bytes')
    add('unicode_result_2048_bytes', 'A', 'A', '😀'*512, '😀'*512)
    add('unicode_result_2049_bytes', 'Ab', 'A', '😀'*512, '', error='result exceeds 2048 UTF-8 bytes')
    add('unicode_replacement_2049_bytes', 'A', 'A', 'é'*1024+'x', '', error='replacement exceeds 2048 UTF-8 bytes')
    add('path128', path='a'*128)
    add('path_two_components128', path='a'*63+'/'+'b'*64)
    add('path129', path='a'*129, error='invalid relative path')
    add('path_empty', path='', error='invalid relative path')
    add('path_unicode', path='资料.txt', error='invalid relative path')
    old_paths = ['../outside.txt', '/tmp/outside.txt', 'docs//a.txt', 'docs/./a.txt', 'a/b/c/d/e', 'docs\\a.txt']
    for index, path in enumerate(old_paths):
        add('proposal_old_invalid_path_'+str(index), path=path, error='invalid relative path')
    add('validated_exact', mode='validate')
    for field, data in [('path', 'other.txt'), ('before', 'stale original'), ('after', 'forged output')]:
        add('validate_changed_'+field, mode='validate', forged={field: data}, error='proposal differs from validated replacement')
    add('validate_rechecks_request', 'aaa', 'aa', 'x', '', mode='validate', error='literal target is ambiguous')
    for index, path in enumerate(['docs/a.txt', *old_paths]):
        add('unchanged_path_contract_'+str(index), path=path, mode='path', error='' if index==0 else 'invalid relative path')
    assert len(values)==60 and len({value['label'] for value in values})==60
    return values


def expression(value):
    record = lambda name, fields: name+' { '+', '.join(key+' = '+literal(data) for key, data in fields.items())+' }'
    return 'Check { label = '+literal(value['label'])+', mode = '+literal(value['mode'])+', request = '+record('Request', value['request'])+', expected = '+record('Proposal', value['expected'])+', error = '+literal(value['error'])+' }'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--etas')
    parser.add_argument('--prepare-only',action='store_true')
    parser.add_argument('--reuse-root-check',type=Path)
    args=parser.parse_args(); values=cases()
    args.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='edit-proposal-',dir=args.evidence_dir))
    result=dict(task='TOOL-002A',status='prepared',checks=[value['label'] for value in values],commands=[])
    output=evidence/'results.json'
    def save(): output.write_text(json.dumps(result,indent=2)+'\n')
    def resources():
        return {name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in
                ['memory.max','memory.peak','memory.events','cpu.max','pids.max'] if (Path('/sys/fs/cgroup')/name).exists()}
    def run(label,command,expected=None):
        item=dict(label=label,command=list(map(str,command)));result['commands'].append(item);save()
        observed=subprocess.run(item['command'],capture_output=True,timeout=180)
        (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout);(evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
        item.update(exit=observed.returncode,stdout=observed.stdout.decode(),stderr=observed.stderr.decode());save()
        assert observed.returncode==0 and not observed.stderr,item
        if expected is not None: assert item['stdout']==expected,item
        return item['stdout']
    template=FIXTURE.read_text(); groups=[values[n:n+12] for n in range(0,len(values),12)]
    for index,group in enumerate(groups):
        project=evidence/('batch-'+str(index));(project/'src/app').mkdir(parents=True)
        for name in MODULES:
            target=project/'src/nomo'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/'src/nomo'/name,target)
        (project/'src/app/contract_probe.es').write_text(template.replace('__CHECKS__','['+',\n'.join(map(expression,group))+']'))
        (project/'etas.toml').write_text(helper.MANIFEST.replace('harness-checkpoint-contract-probe','edit-proposal-probe'))
    save();print('EVIDENCE '+str(evidence),flush=True)
    if args.prepare_only:return
    result['resources_before']=resources()
    try:
        cli=verify_cli();assert not args.etas or Path(args.etas).resolve()==cli.resolve()
        result['compiler']=str(cli);result['status']='running';save()
        if args.reuse_root_check:
            prior=json.loads(args.reuse_root_check.read_text())['commands'][0]
            assert prior['label']=='root-check' and prior['exit']==0 and prior['stdout']=='checked 55 files\n' and not prior['stderr']
            assert prior['command']==[str(cli),'check','--all',str(ROOT)]
            result['reused_root_check']=dict(source=str(args.reuse_root_check),command=prior);save()
        else:
            run('root-check',[cli,'check','--all',ROOT],'checked 55 files\n')
        for index,group in enumerate(groups):
            project=evidence/('batch-'+str(index));prefix='batch-'+str(index)
            run(prefix+'-check',[cli,'check','--all',project],'checked 3 files\n')
            effects=run(prefix+'-pure-effects',[cli,'effects',project,'--flow','pure_probe'])
            assert effects.count('requested actions: []')==effects.count('default actions: []')==1,effects
            run(prefix+'-observe',[cli,'run',project,'--flow','observe','--allow-effects'],''.join('PASS '+value['label']+'\n' for value in group))
    except BaseException as error:
        result.update(status='failed',failure=repr(error));save();raise
    finally:
        result['resources_after']=resources()
        if result['resources_after']:
            events=dict(line.split() for line in result['resources_after']['memory.events'].splitlines())
            valid=result['resources_after']['memory.max']=='4294967296' and all(events[name]=='0' for name in ['max','oom','oom_kill','oom_group_kill'])
            if not valid:
                result.update(status='failed',resource_failure='ordinary 4-GiB/zero-limit-event guard failed');save()
                raise AssertionError(result['resource_failure'])
        save()
    assert len(result['commands'])==len(groups)*3+(0 if args.reuse_root_check else 1)
    result['status']='passed';save();print('PASS '+str(len(values))+' edit/path/encoding checks in '+str(len(result['commands']))+' actual commands',flush=True)


if __name__=='__main__':main()
