#!/usr/bin/env python3
"""Exercise selected-file bounds against the official ETAS filesystem host."""
import importlib.util, json, shutil, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent

def main():
    spec=importlib.util.spec_from_file_location('verified_etas',ROOT/'scripts/nomo-verified-etas.py')
    verified=importlib.util.module_from_spec(spec);spec.loader.exec_module(verified)
    if not verified.verify(verified.CLI,ROOT/'config/etas-025-official.json',ROOT/'config/etas-025-official.Cargo.lock','latest025'):
        raise RuntimeError('official ETAS 0.2.5 identity mismatch')
    with tempfile.TemporaryDirectory(prefix='nomo-multifile-') as directory:
        project=Path(directory);shutil.copytree(ROOT/'src',project/'src')
        (project/'src/app').mkdir(exist_ok=True)
        shutil.copyfile(ROOT/'tests/fixtures/multifile/probe.es',project/'src/app/multifile.es')
        shutil.copyfile(ROOT/'etas.lock',project/'etas.lock')
        manifest='''
[package]
name = "nomo"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "multifile-test"
[runtime.profiles.multifile-test]
boundary_policy = "nomo-tool001a"
[runtime.profiles.multifile-test.filesystem.regions."nomo.tools.workspace.ReadOnlyRoot"]
root = "fixture"
read = true
write = false
[runtime.profiles.multifile-test.policy]
mode = "local-static"
rules = ["console=allow", "filesystem=allow"]
[runtime.profiles.multifile-test.approval]
mode = "deny"
[[bin]]
name = "multifile-search-test"
module = "app.multifile"
flow = "search_probe"
profile = "multifile-test"
'''
        (project/'etas.toml').write_text(manifest)
        fixture=project/'fixture';fixture.mkdir()
        for name,body in {'a.txt':b'a'*1024,'b.txt':b'b'*1024,'c.txt':b'c'*1024,
                          'd.txt':b'needle'+b'd'*1018,'e.txt':b'e'*1025,'wide.txt':b'w'*2048,
                          'empty.txt':b'','invalid.txt':b'\xff'}.items():(fixture/name).write_bytes(body)
        before={p.name:p.read_bytes() for p in fixture.iterdir()}
        check=subprocess.run(['etas','check','--all',str(project)],capture_output=True,text=True,timeout=60)
        if check.returncode:raise AssertionError('check failed: '+(check.stdout+check.stderr)[-4000:])
        def run(flow):return subprocess.run(['etas','run',str(project),'--flow',flow,'--profile','multifile-test','--allow-effects'],capture_output=True,text=True,timeout=60)
        good=run('search_probe')
        if good.returncode or 'PASS bounded multifile search and legacy identity' not in good.stdout:raise AssertionError('search failed: '+(good.stdout+good.stderr)[-4000:])
        (project/'etas.toml').write_text(manifest.replace('flow = "search_probe"','flow = "missing_probe"'))
        missing=run('missing_probe')
        if missing.returncode==0 or 'UNEXPECTED' in missing.stdout:raise AssertionError('missing read was reported complete')
        if before!={p.name:p.read_bytes() for p in fixture.iterdir()}:raise AssertionError('read-only fixture changed')
    print(json.dumps({'status':'passed','scope':'synthetic real ETAS bounded four-file search; no model','exact_bytes':4096,'overflow_refused':True,'missing_file_not_complete':True,'legacy_identity_guard':True,'legacy_work_record_guard':True}))

if __name__=='__main__':main()
