#!/usr/bin/env python3
"""Exercise shared recorded-work argument parsing on the official ETAS graph."""
import os,shutil,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='nomo-recorded-args-') as directory:
 project=Path(directory)/'project';shutil.copytree(root,project,ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__'));(project/'.etas').mkdir()
 main=project/'src/nomo/main.es';source=main.read_text().replace('module nomo.main;','module nomo.main;\nimport nomo.cli.harness_work_args.parse_recorded;',1)
 source+='''
public flow recorded_args_probe(args: Array<string>) -> i32 {
    let base = ["--id", "edit1", "--workspace", "private-workspace", "--path", "note.txt", "--once", "change text", "--allow", "note.txt"];
    match parse_recorded(base, 0, true) { Ok(value) => { if value.has_check || value.digest != "" || value.input.edit.path != "note.txt" { return 1; } } Err(_) => { return 2; } }
    let check = base.push("--check-ref").push("digest");
    match parse_recorded(check, 0, true) { Ok(value) => { if !value.has_check || value.digest != "digest" || value.input.edit.id != "edit1" { return 3; } } Err(_) => { return 4; } }
    let event = check.push("--policy-binding").push("binding");
    match parse_recorded(event, 2, true) { Ok(value) => { if !value.has_check || value.digest != "digest" { return 5; } } Err(_) => { return 6; } }
    let empty = base.push("--check-ref").push("");
    match parse_recorded(empty, 0, true) { Err(error) => { if error != "invalid check reference" { return 7; } } Ok(_) => { return 8; } }
    let legacy_event = empty.push("--policy-binding").push("binding");
    match parse_recorded(legacy_event, 2, false) { Ok(value) => { if !value.has_check || value.digest != "" { return 9; } } Err(_) => { return 10; } }
    match parse_recorded([], 2, true) { Err(_) => {} Ok(_) => { return 11; } }
    return 0;
}
'''
 main.write_text(source)
 command=['docker','compose','--env-file','/dev/null','-f','compose.yaml','-f','config/etas-026-official-compose.yaml','-f','config/etas-runtime-cache-compose.yaml','run','--rm','--no-deps','-T','dev','python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow','recorded_args_probe','--profile','foundation','--allow-effects']
 env=dict(os.environ,NOMO_ETAS_GRAPH='026-v68',PATH='/Applications/Docker.app/Contents/Resources/bin:'+os.environ['PATH'])
 result=subprocess.run(command,cwd=project,env=env,capture_output=True,text=True,timeout=180)
 assert result.returncode==0 and '"value":"0"' in result.stdout.replace(' ',''),(result.returncode,result.stdout[-2500:],result.stderr[-2500:])
 print('PASS recorded work args, legacy/event trailers, check identity, and empty-digest admission')
