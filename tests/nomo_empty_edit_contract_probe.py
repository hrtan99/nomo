#!/usr/bin/env python3
"""Check empty-file edit boundaries with the selected official ETAS graph."""
import os,shutil,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='nomo-empty-edit-contract-') as directory:
 project=Path(directory)/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__'));(project/'.etas').mkdir()
 main=project/'src/nomo/main.es';source=main.read_text().replace('module nomo.main;','module nomo.main;\nimport nomo.tools.edit_proposal.{propose, Request};\nimport nomo.harness.harness_edit_contract.{decode_edit, decode_empty_edit};',1)
 source+='''
public flow empty_edit_contract(args: Array<string>) -> i32 {
    let filled = Request { path = "note.txt", original = "", target = "", replacement = "hello" };
    match propose(filled) { Ok(item) => { if item.before != "" || item.after != "hello" { return 1; } } Err(_) => { return 2; } }
    let no_change = Request { path = "note.txt", original = "", target = "", replacement = "" };
    match propose(no_change) { Err(_) => {} Ok(_) => { return 3; } }
    let ambiguous = Request { path = "note.txt", original = "hello", target = "", replacement = "x" };
    match propose(ambiguous) { Err(_) => {} Ok(_) => { return 4; } }
    let raw = "[\\"edit\\",\\"\\",\\"hello\\"]";
    match decode_edit(raw) { Err(_) => {} Ok(_) => { return 5; } }
    match decode_empty_edit(raw) { Ok(item) => { if item.target != "" || item.replacement != "hello" { return 6; } } Err(_) => { return 7; } }
    return 0;
}
'''
 main.write_text(source)
 command=['docker','compose','--env-file','/dev/null','-f','compose.yaml','-f','config/etas-026-official-compose.yaml','-f','config/etas-runtime-cache-compose.yaml','run','--rm','--no-deps','-T','dev','python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow','empty_edit_contract','--profile','foundation','--allow-effects']
 result=subprocess.run(command,cwd=project,env=dict(os.environ,NOMO_ETAS_GRAPH='026-v68',PATH='/Applications/Docker.app/Contents/Resources/bin:'+os.environ['PATH']),capture_output=True,text=True,timeout=180)
 assert result.returncode==0 and '"value":"0"' in result.stdout.replace(' ',''),(result.returncode,result.stdout[-2500:],result.stderr[-2500:])
 print('PASS empty original, no-op refusal, nonempty-original refusal, and legacy decoder')
