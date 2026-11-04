#!/usr/bin/env python3
"""Verify native path confinement and exact natural edit routing with spaces."""
import os, shutil, subprocess, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory(prefix='nomo-spaced-contract-') as directory:
        project = Path(directory)/'project'
        shutil.copytree(ROOT, project, ignore=shutil.ignore_patterns('.git','.etas','tmp','__pycache__'))
        (project/'.etas').mkdir()
        path=project/'src/nomo/main.es'
        source=path.read_text().replace('module nomo.main;', 'module nomo.main;\nimport nomo.tools.path_policy.valid_path;\nimport nomo.harness.natural_work_chat.target as natural_target;',1)
        source += '''
public flow spaced_path_probe(args: Array<string>) -> i32 {
    if !valid_path("project docs/说明 文件.txt") || !valid_path("dir/two  spaces.txt") || !valid_path("src/routes/[slug]/+page.svelte") || !valid_path("app/(group)/@slot/page.tsx") { return 1; }
    if valid_path("../project docs/x") || valid_path("project docs/../x") || valid_path("/project docs/x") || valid_path("project docs//x") { return 2; }
    if valid_path(" project/x") || valid_path("project /x") || valid_path("project/x ") || valid_path("project/x\\ny") { return 3; }
    let allowed = ["project docs/说明 文件.txt", "dir/two  spaces.txt"];
    if natural_target("EDIT project docs/说明 文件.txt", allowed) != Some("project docs/说明 文件.txt") { return 4; }
    if natural_target("EDIT dir/two  spaces.txt", allowed) != Some("dir/two  spaces.txt") { return 5; }
    if natural_target("EDIT project docs/other file.txt", allowed) != None() || natural_target("EDIT project docs/../x", allowed) != None() { return 6; }
    return 0;
}
'''
        path.write_text(source)
        env=dict(os.environ,NOMO_ETAS_GRAPH='026-v68')
        command=['docker','compose','--env-file','/dev/null','-f','compose.yaml','-f','config/etas-026-official-compose.yaml','-f','config/etas-runtime-cache-compose.yaml','run','--rm','--no-deps','-T','dev','python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow','spaced_path_probe','--profile','foundation','--allow-effects']
        result=subprocess.run(command,cwd=project,env=env,text=True,capture_output=True,timeout=120)
        assert result.returncode==0 and '"value":"0"' in result.stdout.replace(' ',''),(result.stdout,result.stderr)
        print('PASS native path bounds and exact spaced-path routing')

if __name__=='__main__':main()
