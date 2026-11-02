#!/usr/bin/env python3
"""Check rejected ask/chat invocations return process failure without model dispatch."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = '''[package]
name = "read-exit-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "read-exit-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow", "model=deny", "filesystem=deny"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "ask"
module = "nomo.main"
flow = "read_model_tools"
profile = "fixture"
[[bin]]
name = "chat"
module = "nomo.main"
flow = "read_model_tools_chat"
profile = "fixture"
'''

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--etas', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--baseline', action='store_true', help='assert the pre-fix zero-exit bug')
    args = parser.parse_args()
    assert args.etas.is_absolute() and sha(args.etas) == args.sha256
    out = Path(tempfile.mkdtemp(prefix='read-exit-', dir=args.evidence_dir))
    project = out / 'project'
    project.mkdir()
    shutil.copytree(ROOT / 'src', project / 'src')
    (project / 'etas.toml').write_text(MANIFEST)
    sources = {str(p.relative_to(project)): sha(p) for p in (project / 'src').rglob('*.es')}
    result = {'status':'failed', 'scope':'invalid user arguments, no model or file dispatch', 'baseline':args.baseline, 'cases':[]}
    try:
        for name, flow in [('ask','read_model_tools'), ('chat','read_model_tools_chat')]:
            cmd = [str(args.etas),'run',str(project),'--flow',flow,'--allow-effects','--args','invalid']
            proc = subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
            (out / (name + '.stdout')).write_bytes(proc.stdout)
            (out / (name + '.stderr')).write_bytes(proc.stderr)
            result['cases'].append({'name':name,'exit':proc.returncode})
            assert b'REFUSED ' in proc.stdout
            assert (proc.returncode == 0) if args.baseline else (proc.returncode != 0)
        assert all(sha(project / path) == digest for path,digest in sources.items()) and sha(args.etas) == args.sha256
        result['status'] = 'passed'
    except BaseException as error:
        result['failure_type'] = type(error).__name__
    (out / 'result.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'status':result['status'],'evidence':str(out)}))
    return 0 if result['status']=='passed' else 1

if __name__=='__main__':
    raise SystemExit(main())
