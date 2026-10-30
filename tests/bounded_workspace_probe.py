#!/usr/bin/env python3
"""Isolated original product read/search behavior with official-011 and synthetic files."""
import argparse,hashlib,json,pathlib,shutil,subprocess,tempfile,traceback
R=pathlib.Path(__file__).resolve().parent.parent
E=None;T=None
FIXTURE=R/'tests/fixtures/bounded_workspace001/product_probe.es'
SOURCE_SHA='b82d1f7f414f30725aec366fcaa2f39e57c9dba66294f8ebb067d4681c1b4e3e'
MANIFEST='''[package]
name = "bounded-product-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[[bin]]
name = "probe"
module = "app.bounded_product_probe"
flow = "nomo_bounded_probe_exact"
profile = "fixture"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "bounded-product-fixture"
[runtime.profiles.fixture.filesystem.regions."nomo.tools.workspace.ReadOnlyRoot"]
root = "fixture"
read = true
write = false
delete = false
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow", "filesystem:Fs.read=allow", "model=deny", "command=deny", "approval=deny", "memory=deny"]
[runtime.profiles.fixture.approval]
mode = "deny"
'''
CASES={'empty':1,'under':1,'exact':1,'unicode':1,'over':1,'sparse':1,'invalid_utf8':1,'invalid_path':0,'second_file_overflow':2,'missing':1}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def snapshot():return {str(p.relative_to(R)):sha(p) for p in sorted((R/'src').rglob('*.es'))+[R/'etas.toml',R/'etas.lock']}
def trace_check(path,count):
 t=json.loads(path.read_text());starts={};finishes={}
 for e in t['events']:
  if e['kind']=='host_request_started':assert e['id'] not in starts and e['id'] not in finishes;starts[e['id']]=e['qualified_action']
  if e['kind']=='host_request_finished':assert e['id'] in starts and e['id'] not in finishes;finishes[e['id']]=e['outcome']
 assert set(starts)==set(finishes) and t['termination']['local_work_settled'] is True
 assert all(not op['cleanup_errors'] and op['external_outcome']['kind']!='pending' for op in t['termination']['operations'])
 actions=list(starts.values());assert set(actions)<={'Policy.evaluate','Console.stdout_write','Fs.read'} and actions.count('Fs.read')==count
 assert t['outcome']['kind']=='completed';return {'actions':actions,'finish_outcomes':list(finishes.values()),'termination':t['termination'],'outcome':t['outcome']}
def main():
 global E,T
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--evidence-dir',type=pathlib.Path,required=True)
 parser.add_argument('--etas',type=pathlib.Path)
 parser.add_argument('--expected-cli-sha')
 parser.add_argument('--product-manifest',type=pathlib.Path)
 opts=parser.parse_args();assert (opts.etas is None)==(opts.expected_cli_sha is None),'explicit binary and SHA must be paired'
 opts.evidence_dir.mkdir(parents=True,exist_ok=True);E=pathlib.Path(tempfile.mkdtemp(prefix='bounded-workspace-',dir=opts.evidence_dir)).resolve()
 if opts.etas is None:
  from normal_graph_identity import verify_cli
  T=verify_cli()
 else:
  T=opts.etas;assert T.is_absolute() and sha(T)==opts.expected_cli_sha,'explicit test binary identity mismatch'
 result={'status':'failed','scope':'original read_file/search_files candidate on 011, synthetic fixtures; no real user workspace or normal adoption','commands':[],'cases':[]}
 try:
  assert sha(FIXTURE)==SOURCE_SHA
  expected=snapshot();result['source_hashes']=expected;result['binary_sha256']=sha(T)
  if opts.product_manifest is not None:
   assert opts.product_manifest.is_absolute()
   reviewed=json.loads(opts.product_manifest.read_text());assert reviewed['files']==expected,'reviewed product manifest mismatch'
   result['reviewed_manifest_sha256']=sha(opts.product_manifest)
  res={x:(pathlib.Path('/sys/fs/cgroup')/x).read_text().strip() for x in ('memory.max','cpu.max','pids.max')}
  assert res=={'memory.max':'4294967296','cpu.max':'400000 100000','pids.max':'256'}
  root=pathlib.Path(tempfile.mkdtemp(prefix='nomo-bounded-product-',dir='/tmp'));project=root/'project';project.mkdir()
  shutil.copytree(R/'src',project/'src');(project/'src/app').mkdir();shutil.copyfile(FIXTURE,project/'src/app/bounded_product_probe.es');(project/'etas.toml').write_text(MANIFEST)
  fixture=project/'fixture';fixture.mkdir();contents={'empty':b'','under':b'a'*2047,'exact':b'b'*2048,'unicode':('中'*682+'ab').encode(),'over':b'x'*2049,'small':b'safe\n','invalid':b'\xff'}
  for name,data in contents.items():(fixture/(name+'.txt')).write_bytes(data)
  with (fixture/'sparse.txt').open('wb') as f:f.truncate(1<<30)
  (project/'outside.txt').write_bytes(b'OUTSIDE-NOT-READ');before={k:sha(fixture/(k+'.txt')) for k in contents};sparse=(fixture/'sparse.txt').stat().st_size
  def command(name,args):
   p=subprocess.run([str(T),*map(str,args)],cwd=project,capture_output=True,timeout=120)
   (E/(name+'.stdout.bin')).write_bytes(p.stdout);(E/(name+'.stderr.bin')).write_bytes(p.stderr)
   result['commands'].append({'name':name,'argv':list(map(str,args)),'exit':p.returncode,'stdout_sha256':hashlib.sha256(p.stdout).hexdigest(),'stderr_sha256':hashlib.sha256(p.stderr).hexdigest()})
   (E/'partial-results.json').write_text(json.dumps(result,indent=2)+'\n');return p
  checked=command('fixture-check',['--format','json','check','--all',project]);assert checked.returncode==0
  for name in ('empty','missing'):
   p=command(name+'-effects',['--format','json','effects',project,'--flow','nomo_bounded_probe_'+name]);assert p.returncode==0
   values=json.loads(p.stdout)['items'];assert len(values)==1 and 'Fs.read[nomo.tools.workspace.ReadOnlyRoot]' in values[0]['requested_actions']
   assert 'ReadLimitError' not in values[0]['escaping_effects']
   if name=='empty':assert 'std.fs.IOError' in values[0]['escaping_effects']
   if name=='missing':assert 'std.fs.IOError' not in values[0]['escaping_effects']
  for name,count in CASES.items():
   trace=E/(name+'.trace.json');p=command(name,['run',project,'--flow','nomo_bounded_probe_'+name,'--profile','fixture','--allow-effects','--trace-out',trace])
   case={'name':name,'exit':p.returncode,'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace')};result['cases'].append(case)
   expected_line='PASS missing IOError' if name=='missing' else 'PASS '+name
   assert p.returncode==0 and p.stdout.decode().splitlines()==[expected_line] and b'UNEXPECTED' not in p.stdout,case
   case['trace']=trace_check(trace,count)
  assert before=={k:sha(fixture/(k+'.txt')) for k in contents} and sparse==(fixture/'sparse.txt').stat().st_size
  assert (project/'outside.txt').read_bytes()==b'OUTSIDE-NOT-READ' and snapshot()==expected and sha(FIXTURE)==SOURCE_SHA
  result['resources']={x:(pathlib.Path('/sys/fs/cgroup')/x).read_text().strip() for x in ('memory.max','memory.peak','memory.events','cpu.max','pids.max','pids.peak')}
  events=dict(line.split() for line in result['resources']['memory.events'].splitlines());assert events['oom']=='0' and events['oom_kill']=='0'
  result['status']='passed'
 except BaseException:result['failure']=traceback.format_exc()
 (E/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'evidence':str(E),'failure':result.get('failure')}));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
