#!/usr/bin/env python3
"""Native ETAS tests for unique, overlapping and large edit targets."""
import argparse, itertools, json, os, random, shutil, subprocess, tempfile, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent


def literal(value):
    return json.dumps(value, ensure_ascii=False)


def scenarios():
    rng=random.Random(6153)
    rows=[('aaa','aa'),('ababa','aba'),('ééé','éé'),('😀😀😀','😀😀'),('abcabc','abc'),('abc','x'),('前a後','a'),('a','a'),('','x')]
    alphabet='abé😀'
    for _ in range(240):
        original=''.join(rng.choice(alphabet) for _ in range(rng.randrange(12)))
        target=''.join(rng.choice(alphabet) for _ in range(1,rng.randrange(2,6)))
        rows.append((original,target))
    return rows


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--baseline',type=Path);parser.add_argument('--benchmark-only',action='store_true');args=parser.parse_args()
    roots=[('candidate',ROOT)] + ([('baseline',args.baseline)] if args.baseline else [])
    records=[]
    for original,target in scenarios():
        occurrences=sum(original.startswith(target,i) for i in range(len(original)))
        expected='literal target not found' if occurrences==0 else 'literal target is ambiguous' if occurrences>1 else ''
        after=original.replace(target,'Z',1) if occurrences==1 else ''
        records.append('Case { original = '+literal(original)+', target = '+literal(target)+', after = '+literal(after)+', error = '+literal(expected)+' }')
    for label,root in roots:
        with tempfile.TemporaryDirectory(prefix='nomo-overlap-') as directory:
            project=Path(directory)/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__'));(project/'.etas').mkdir()
            main_file=project/'src/nomo/main.es';source=main_file.read_text().replace('module nomo.main;','module nomo.main;\nimport nomo.tools.edit_proposal.{propose, Request};',1)
            source+='\ntype Case = { original: string, target: string, after: string, error: string };\n'
            source+='public flow overlap_probe(args: Array<string>) -> i32 {\n    let cases: Array<Case> = ['+',\n'.join(records)+'];\n'
            source+='    for item in cases limit Iterations(250) {\n        let request = Request { path = "note.txt", original = item.original, target = item.target, replacement = "Z" };\n        match propose(request) { Ok(value) => { if item.error != "" || value.after != item.after { return 1; } } Err(error) => { if error != item.error { return 2; } } }\n    }\n    return 0;\n}\n'
            repeated_bench='a'*1023; target_bench=repeated_bench+'b'; original_bench=target_bench+'a'*1024
            source+='public flow overlap_benchmark(args: Array<string>) -> i32 {\n    let request = Request { path = "note.txt", original = '+literal(original_bench)+', target = '+literal(target_bench)+', replacement = "Z" };\n    return match propose(request) { Ok(value) => if value.after == '+literal('Z'+'a'*1024)+' { 0 } else { 1 }, Err(_) => 2 };\n}\n'
            if label=='candidate':
                repeated='a'*32767;target=repeated+'b';original=target+'a'*32768
                assert len(original)==65536
                source+='public flow large_overlap_probe(args: Array<string>) -> i32 {\n    let request = Request { path = "note.txt", original = '+literal(original)+', target = '+literal(target)+', replacement = "Z" };\n    match propose(request) { Ok(value) => { if value.after != '+literal('Z'+'a'*32768)+' { return 1; } } Err(_) => { return 2; } }\n    let ambiguous = Request { path = "note.txt", original = '+literal('a'*32769)+', target = '+literal('a'*32768)+', replacement = "Z" };\n    return match propose(ambiguous) { Err(error) => if error == "literal target is ambiguous" { 0 } else { 3 }, Ok(_) => 4 };\n}\n'
            main_file.write_text(source)
            env=dict(os.environ,NOMO_ETAS_GRAPH='026-v68')
            flows = ['overlap_benchmark'] if args.benchmark_only else (['overlap_probe','large_overlap_probe'] if label=='candidate' else ['overlap_probe'])
            for flow in flows:
                command=['docker','compose','--env-file','/dev/null','-f','compose.yaml','-f','config/etas-026-official-compose.yaml','-f','config/etas-runtime-cache-compose.yaml','run','--rm','--no-deps','-T','dev','python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow',flow,'--profile','foundation','--allow-effects']
                start=time.monotonic();result=subprocess.run(command,cwd=project,env=env,capture_output=True,text=True,timeout=240)
                assert result.returncode==0 and '"value":"0"' in result.stdout.replace(' ',''),(label,flow,result.stdout[-3000:],result.stderr[-3000:])
                print(label,flow,'passed',round(time.monotonic()-start,2),'s',flush=True)
    if args.benchmark_only: print('PASS repeated-target runtime comparison',flush=True)
    else: print('PASS',len(records),'small unique/overlap cases and 65536-byte repeated target',flush=True)

if __name__=='__main__':main()
