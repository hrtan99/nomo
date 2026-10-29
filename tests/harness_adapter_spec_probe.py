#!/usr/bin/env python3
"""D13 callable adapter qualification; static checks only."""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path
from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import resources
from normal_graph_identity import verify_cli
ROOT=Path(__file__).resolve().parent.parent
FIXTURES=ROOT/'tests/fixtures/harness_adapter_specs001'

def main():
    p=argparse.ArgumentParser();p.add_argument('--evidence-dir',type=Path,required=True);p.add_argument('--prepare-only',action='store_true');p.add_argument('--negatives-only',action='store_true');args=p.parse_args();args.evidence_dir.mkdir(parents=True,exist_ok=True)
    e=Path(tempfile.mkdtemp(prefix='harness-adapter-spec-',dir=args.evidence_dir));project=e/'product';(project/'src').mkdir(parents=True);print('EVIDENCE '+str(e),flush=True);sources={}
    for src in sorted((ROOT/'src/nomo').rglob('*.es')):
        dst=project/'src'/src.relative_to(ROOT/'src');dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);sources[str(src.relative_to(ROOT))]=hashlib.sha256(src.read_bytes()).hexdigest()
    for name in ['etas.toml','etas.lock']:shutil.copyfile(ROOT/name,project/name)
    negatives=[]
    for family in ['read','edit','chain']:
        for kind in ['wrong_input','wrong_output','extra_error']:
            name=family+'_'+kind;neg=e/name;shutil.copytree(project,neg);(neg/'src/app').mkdir();shutil.copyfile(FIXTURES/(name+'.es'),neg/'src/app/callable_negative.es');(neg/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','harness-adapter-negative').replace('app.contract_probe','app.callable_negative'));(neg/'etas.lock').unlink();negatives.append((name,kind))
    name='chain_wrong_parent';neg=e/name;shutil.copytree(project,neg);(neg/'src/app').mkdir();shutil.copyfile(FIXTURES/(name+'.es'),neg/'src/app/callable_negative.es');(neg/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe','harness-adapter-negative').replace('app.contract_probe','app.callable_negative'));(neg/'etas.lock').unlink();negatives.append((name,'wrong_input'))
    result={'status':'prepared','sources':sources,'negatives':[x[0] for x in negatives],'commands':[],'qualification':('Ten isolated callable negative projects only; no source/effects replay.' if args.negatives_only else 'Full source and static effects plus ten isolated callable negative projects.') + ' No application flows or native Model/Fs/Memory/Approval/Command/SSH.'};out=e/'results.json'
    def save():out.write_text(json.dumps(result,indent=2)+'\n')
    save()
    if args.prepare_only:return
    try:
        cli=str(verify_cli());count=len(list((project/'src').rglob('*.es')));env={k:os.environ[k] for k in ['PATH','HOME','LANG','CARGO_HOME','CARGO_TARGET_DIR'] if k in os.environ};env.update(NOMO_NORMAL_GRAPH='latest',ETAS_HOST_FILESYSTEM='none',ETAS_HOST_MEMORY='none',ETAS_HOST_SESSION='none',ETAS_HOST_APPROVAL='deny')
        def invoke(label,argv):
            command=[cli,'--no-config',*map(str,argv)];item={'label':label,'command':command};result['commands'].append(item);save();r=subprocess.run(command,capture_output=True,input=b'',env=env,timeout=240);(e/(label+'.stdout.bin')).write_bytes(r.stdout);(e/(label+'.stderr.bin')).write_bytes(r.stderr);item.update(exit=r.returncode,stdout=r.stdout.decode(),stderr=r.stderr.decode());save();return item
        if not args.negatives_only:
            item=invoke('check',['check','--all',project]);assert item['exit']==0 and not item['stderr'] and item['stdout']=='checked '+str(count)+' files\n'
            item=invoke('effects',['--format','json','effects',project]);assert item['exit']==0 and not item['stderr'];data=json.loads(item['stdout']);assert data['command']=='effects' and not data['diagnostics'];result['effects_captured']=True;save()
        expected={'wrong_input':('type::TypeMismatch','implementation input type does not satisfy the callable spec'),'wrong_output':('type::TypeMismatch','implementation output type does not satisfy the callable spec'),'extra_error':('effect::EffectOutsideDeclaredRow','implementation escaping effects do not satisfy the callable spec bound')}
        for name,kind in negatives:
            neg=e/name;item=invoke(name,['--format','json','check','--all',neg]);assert item['exit']!=0 and not item['stderr'];report=json.loads(item['stdout']);diags=[(Path(f['path']).resolve(),d) for f in report['files'] for d in f['diagnostics']];assert len(diags)==1,(name,diags)
            path,d=diags[0];src=neg/'src/app/callable_negative.es';line=next(i for i,x in enumerate(src.read_text().splitlines(),1) if x.startswith('flow bad('));code,message=expected[kind];assert path==src.resolve() and d['severity']=='error' and d['code']==code and d['message']==message and d['primary']['span']['startLine']==line,(name,d)
        result['status']='passed_negatives_only' if args.negatives_only else 'passed_pending_effect_audit'
    except BaseException as err:result.update(status='failed',failure=repr(err));raise
    finally:
        result['resources'],valid=resources()
        if not valid:result.update(status='failed',resource_failure='ordinary 4GiB guard')
        save();assert valid,str(e)
    print('PASS D13 ten callable negatives only' if args.negatives_only else 'PASS D13 source, effects and ten callable negatives',flush=True)
if __name__=='__main__':main()
