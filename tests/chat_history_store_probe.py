#!/usr/bin/env python3
"""Exercise untrusted chat-history storage across independent ETAS processes."""
import hashlib,json,shutil,sqlite3,subprocess,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
CLI=Path('/home/nomo/.cargo/bin/etas')
SHA='67802d5015aea771ab02d8e474ea18d8a83f4fdb8e06ef1a8fd9349ffadb2290'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    assert digest(CLI)==SHA
    root=Path(tempfile.mkdtemp(prefix='nomo-chat-history-'));project=root/'project';project.mkdir()
    shutil.copytree(ROOT/'src',project/'src');(project/'src/app').mkdir()
    shutil.copyfile(ROOT/'tests/fixtures/chat_history/probe.es',project/'src/app/chat_history_probe.es')
    shutil.copyfile(ROOT/'tests/fixtures/chat_history/contract_probe.es',project/'src/app/chat_session_contract_probe.es')
    entry=project/'src/app/chat_history_probe.es';entry.write_text(entry.read_text().replace('module app.chat_history_probe;','module app.chat_history_probe;\nimport app.chat_session_contract_probe.chat_session_contract_probe as contract;')+'\npublic flow run_contract(args: Array<string>) -> i32 ![Console, Error<IOError>, Error<IndexError>] { return contract(); }\n')
    db=root/'history.sqlite3';(project/'etas.toml').write_text('''[package]
name = "chat-history-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "history-probe"
[runtime.profiles.fixture.memory]
backend = "sqlite"
path = %s
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow", "memory=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.chat_history_probe"
flow = "chat_history_probe"
profile = "fixture"
[[bin]]
name = "contract-probe"
module = "app.chat_session_contract_probe"
flow = "chat_session_contract_probe"
profile = "fixture"
'''%json.dumps(str(db)))
    commands=[('check',[str(CLI),'check','--all',str(project)],None),
              ('contract',[str(CLI),'run',str(project),'--flow','run_contract','--allow-effects'],b'PASS preserved budget and unresolved reservation\n'),
              *[(name,[str(CLI),'run',str(project),'--flow','chat_history_probe','--allow-effects','--args',name],expected) for name,expected in
                [('first',b'FIRST_SAVED\n'),('show',b'HISTORY_RELOADED\n'),('replace',b'STALE_REFUSED\n'),('second-reserve',b'SECOND_RESERVED\n'),('second-show',b'SECOND_RELOADED\n'),('second-complete',b'SECOND_SAVED\n'),('final',b'FINAL_RELOADED\n'),('invalid',b'INVALID_REFUSED\n')]]]
    for name,cmd,want in commands:
        before=None
        if name in ('show','second-show','final','invalid'):
            with sqlite3.connect(db) as c:before=list(c.iterdump())
        result=subprocess.run(cmd,capture_output=True,timeout=120)
        if result.returncode or result.stderr or (want is not None and result.stdout!=want):
            print(json.dumps({'status':'failed','stage':name,'exit':result.returncode,'stdout':result.stdout.decode(errors='replace')[-5000:],'stderr':result.stderr.decode(errors='replace')[-5000:]}));return 1
        if before is not None:
            with sqlite3.connect(db) as c:assert before==list(c.iterdump())
    with sqlite3.connect(db) as c:
        assert c.execute('pragma integrity_check').fetchone()==('ok',)
        rows=c.execute("select count(*) from memory_entries where region='nomo-chat-history-v1'").fetchone()[0];assert rows==1
    assert digest(CLI)==SHA
    print(json.dumps({'status':'passed','separate_processes':8,'invalid_and_stale_refused':True,'reservation_and_budget_checked':True,'read_only_snapshots_unchanged':True,'sqlite_integrity':'ok','scope':'synthetic history storage only; no workspace identity, workspace action or live model'}));return 0
if __name__=='__main__':raise SystemExit(main())
