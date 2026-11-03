#!/usr/bin/env python3
"""Synthetic recoverable work reservation and atomic selected-facts frame."""
import base64
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CLI = Path('/home/nomo/.cargo/bin/etas')
MANIFEST = '''[package]
name = "recoverable-work-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "recoverable-work-probe"
[runtime.profiles.fixture.memory]
backend = "sqlite"
path = "history.sqlite3"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow", "memory=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.recoverable_work_probe"
flow = "recoverable_work_probe"
profile = "fixture"
'''


def main():
    spec = json.loads((ROOT/'config/etas-025-official.json').read_text())
    digest = hashlib.sha256(CLI.read_bytes()).hexdigest()
    if digest != spec['verified_seed_binary_sha256']:raise ValueError('official CLI identity mismatch')
    with tempfile.TemporaryDirectory(prefix='recoverable-work-') as temp:
        base=Path(temp);project=base/'project';project.mkdir()
        shutil.copytree(ROOT/'src',project/'src');(project/'src/app').mkdir()
        shutil.copyfile(ROOT/'tests/fixtures/recoverable_work/probe.es',project/'src/app/recoverable_work_probe.es')
        (project/'etas.toml').write_text(MANIFEST)
        running=base/'running';running.mkdir();complete=base/'complete';complete.mkdir()
        commands=[('check',[str(CLI),'check','--all',str(project)],base)]
        for phase,cwd in [('reserve',running),('inspect-running',running),('finish',complete)]:
            commands.append((phase,[str(CLI),'run',str(project),'--flow','recoverable_work_probe','--allow-effects','--args',phase],cwd))
        checks=[]
        for phase,command,cwd in commands:
            result=subprocess.run(command,capture_output=True,text=True,cwd=cwd,timeout=120)
            checks.append({'phase':phase,'exit':result.returncode,'stdout':result.stdout[-1500:],'stderr':result.stderr[-3000:]})
            if result.returncode or result.stderr:break
        success=len(checks)==len(commands) and all(item['exit']==0 for item in checks)
        artifacts={}
        if success:
            for name,cwd in [('running',running),('complete',complete)]:
                path=cwd/'history.sqlite3'
                with closing(sqlite3.connect(path)) as db:
                    assert db.execute('pragma integrity_check').fetchone()==('ok',)
                    rows=db.execute("select value_json from memory_entries where region='nomo-recoverable-work-v1'").fetchall()
                    assert len(rows)==1 and 'VERY_SECRET_123' not in rows[0][0]
                for artifact in cwd.glob('history.sqlite3*'):
                    data=artifact.read_bytes();assert b'VERY_SECRET_123' not in data and len(data)<=1048576
                    artifacts[name+'/'+artifact.name]={'sha256':hashlib.sha256(data).hexdigest(),'base64':base64.b64encode(data).decode('ascii')}
        print(json.dumps({'status':'passed' if success else 'failed','scope':'isolated synthetic work reservation and selected-facts frame; no edit, check, production route or complete redaction','cli_sha256':digest,'checks':checks,'synthetic_sqlite_artifacts':artifacts},indent=2))
        return 0 if success else 1


if __name__=='__main__':raise SystemExit(main())
