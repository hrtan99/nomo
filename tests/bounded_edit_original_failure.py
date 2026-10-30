#!/usr/bin/env python3
"""Actual bounded edit reader and two direct consumers on owned fixtures only."""
import argparse,hashlib,json,shutil,subprocess,tempfile,traceback
from pathlib import Path
from normal_graph_identity import verify_cli
ROOT=Path(__file__).resolve().parent.parent
FIXTURE=ROOT/'tests/fixtures/bounded_edit_read001/probe.es'
MANIFEST='''[package]
name = "bounded-edit-read-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[[bin]]
name = "probe"
module = "app.bounded_edit_probe"
flow = "bounded_edit_probe_empty"
profile = "fixture"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "bounded-edit-fixture"
[runtime.profiles.fixture.filesystem.regions."nomo.tools.edit_file.EditableRoot"]
root = "fixture"
read = true
write = true
delete = false
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow", "filesystem:Fs.stat=allow", "filesystem:Fs.read=allow", "filesystem:Fs.atomic_replace=allow", "model=deny", "command=deny", "approval=deny", "memory=deny"]
[runtime.profiles.fixture.approval]
mode = "deny"
'''
CASES={'empty':(1,1,0),'exact':(1,1,0),'unicode':(1,1,0),'over':(1,0,0),'invalid_utf8':(1,1,0),'missing':(1,0,0),'invalid_path':(0,0,0),'prepare_consumer':(1,1,0),'apply_changed':(1,1,0),'apply_success':(2,2,1)}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--evidence-dir',type=Path,required=True);opts=parser.parse_args();opts.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='bounded-edit-',dir=opts.evidence_dir));out={'status':'failed','scope':'official native read and direct prepare/apply consumers on fresh synthetic fixture; no model, memory, approval, real project or concurrent writer','cases':[]}
    try:
        cli=verify_cli();project=Path(tempfile.mkdtemp(prefix='bounded-edit-project-',dir='/tmp'));shutil.copytree(ROOT/'src',project/'src');(project/'src/app').mkdir();shutil.copyfile(FIXTURE,project/'src/app/bounded_edit_probe.es');(project/'etas.toml').write_text(MANIFEST)
        fixture=project/'fixture';fixture.mkdir();content={'empty.txt':b'','exact.txt':b'a'*2048,'unicode.txt':('中'*682+'ab').encode(),'over.txt':b'b'*2049,'invalid.txt':b'\xff','small.txt':b'old\n','changed.txt':b'external\n'}
        for name,data in content.items():(fixture/name).write_bytes(data)
        (project/'outside.txt').write_bytes(b'OUTSIDE_NOT_READ')
        src={str(p.relative_to(ROOT)):sha(p) for p in sorted((ROOT/'src').rglob('*.es'))};out['source_hashes']=src;out['fixture_sha256']=sha(FIXTURE);out['cli_sha256']=sha(cli)
        effects=subprocess.run([str(cli),'--format','json','effects',str(project),'--flow','bounded_edit_probe_empty'],cwd=project,capture_output=True,timeout=120)
        (evidence/'effects.stdout.bin').write_bytes(effects.stdout);(evidence/'effects.stderr.bin').write_bytes(effects.stderr)
        assert effects.returncode==0 and not effects.stderr
        items=json.loads(effects.stdout)['items'];assert len(items)==1
        row=items[0]
        def parse_list(value):
            assert isinstance(value,str) and value.startswith('[') and value.endswith(']')
            return set(value[1:-1].split(', ')) if value!='[]' else set()
        actions=parse_list(row['requested_actions']);escaping=parse_list(row['escaping_effects'])
        assert {'Fs.read[nomo.tools.edit_file.EditableRoot]','Fs.stat[nomo.tools.edit_file.EditableRoot]'} <= actions
        assert 'Error<std.fs.IOError>' in escaping and not any('ReadLimitError' in effect for effect in escaping)
        out['effects_sha256']=sha(evidence/'effects.stdout.bin')
        for name,expected in CASES.items():
            trace=evidence/(name+'.trace.json');p=subprocess.run([str(cli),'run',str(project),'--flow','bounded_edit_probe_'+name,'--profile','fixture','--allow-effects','--trace-out',str(trace)],cwd=project,capture_output=True,timeout=120)
            (evidence/(name+'.stdout.bin')).write_bytes(p.stdout);(evidence/(name+'.stderr.bin')).write_bytes(p.stderr)
            expected_line=b'PASS missing IOError\n' if name=='missing' else ('PASS '+name+'\n').encode();assert p.returncode==0 and p.stdout==expected_line and not p.stderr,(name,p.returncode)
            t=json.loads(trace.read_text());starts={};ends={}
            for event in t['events']:
                if event['kind']=='host_request_started':assert event['id'] not in starts;starts[event['id']]=event['qualified_action']
                if event['kind']=='host_request_finished':assert event['id'] in starts and event['id'] not in ends;ends[event['id']]=event['outcome']
            assert starts.keys()==ends.keys() and t['termination']['local_work_settled'] and t['outcome']['kind']=='completed' and all(not x['cleanup_errors'] for x in t['termination']['operations'])
            actions=list(starts.values());assert set(actions)<={'Policy.evaluate','Console.stdout_write','Fs.stat','Fs.read','Fs.atomic_replace'}
            assert tuple(actions.count(x) for x in ('Fs.stat','Fs.read','Fs.atomic_replace'))==expected,(name,actions)
            out['cases'].append({'name':name,'exit':p.returncode,'actions':actions,'finish_outcomes':list(ends.values()),'trace_sha256':sha(trace)})
        for name,data in content.items():assert (fixture/name).read_bytes()==(b'new\n' if name=='small.txt' else data)
        assert (project/'outside.txt').read_bytes()==b'OUTSIDE_NOT_READ';assert src=={str(p.relative_to(ROOT)):sha(p) for p in sorted((ROOT/'src').rglob('*.es'))}
        out['status']='passed'
    except BaseException:out['failure']=traceback.format_exc()
    finally:
        r={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']};out['resources']=r;events=dict(x.split() for x in r['memory.events'].splitlines())
        if r['memory.max']!='4294967296' or r['cpu.max']!='400000 100000' or r['pids.max']!='256' or any(events[k]!='0' for k in ['max','oom','oom_kill','oom_group_kill']):out.update(status='failed',resource_failure='ordinary lane guard')
        (evidence/'result.json').write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps({'status':out['status'],'evidence':str(evidence),'failure':out.get('failure')}));return 0 if out['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
