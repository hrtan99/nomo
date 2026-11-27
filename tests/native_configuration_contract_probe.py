"""One positive configuration-cache and instruction flow with controlled application effects."""
from pathlib import Path
from native_sources import copy_sources
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-configuration-contract-')).resolve()
    package, state = evidence / 'package', evidence / 'state'
    package.mkdir()
    (package / '.etas').mkdir()
    state.mkdir(mode=0o777)
    state.chmod(0o777)
    guidance = evidence / 'guidance'
    (guidance / 'src').mkdir(parents=True)
    (guidance / 'AGENTS.md').write_text('Root guidance')
    (guidance / 'src/AGENTS.md').write_text('Scoped guidance')
    fixture = ROOT / 'tests/fixtures/native_configuration_contract/src/app/main.es'
    sources = copy_sources(ROOT, package, fixture)
    (evidence / 'sources.json').write_text(json.dumps(sources, indent=2) + '\n')
    (package / 'etas.toml').write_text('''[package]
name = "native-configuration-contract"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.memory]
backend = "sqlite"
path = "/state/history.sqlite3"
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["memory=allow", "console=allow", "filesystem:Fs.read=allow", "filesystem:Fs.list=allow"]
[runtime.profiles.local.filesystem.regions."nomo.native.workspace.ProjectRoot"]
root = "/guidance"
read = true
write = false

[[bin]]
name = "native-configuration-contract"
module = "app.main"
flow = "main"
''')
    (package / 'etas.lock').write_text('version = 1\nmanifest_fingerprint = "etas-lock-input:v1|package=native-configuration-contract|version=0.1.0|edition=2026"\npackage = []\n')
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {'volumes': [
        {'type': 'bind', 'source': str(package), 'target': '/workspace', 'read_only': True},
        {'type': 'bind', 'source': str(state), 'target': '/state'},
        {'type': 'bind', 'source': str(guidance), 'target': '/guidance', 'read_only': True}]}}}))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0243-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    inside = '''import json,pathlib,subprocess
cmd=['/home/nomo/.cargo/bin/etas','--no-config','--cache','off','run','/workspace','--allow-effects','--trace-out','/state/controlled.trace.json']
p=subprocess.run(cmd,capture_output=True,text=True)
physical={}
if p.returncode==0:
 qcmd=[arg.replace('/state/controlled.trace.json','/state/guidance.trace.json') for arg in cmd]+['--flow','physical_guidance']
 q=subprocess.run(qcmd,capture_output=True,text=True)
 physical={'exit':q.returncode,'stdout':q.stdout,'stderr':q.stderr}
r={name:(pathlib.Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
print(json.dumps({'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'resources':r,'physical':physical}))'''
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev', 'python3', '-c', inside]
    print('EVIDENCE ' + str(evidence), flush=True)
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=300)
    (evidence / 'container-stderr.txt').write_text(result.stderr)
    assert result.returncode == 0, result.stderr
    record = json.loads(result.stdout)
    (evidence / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    assert record['exit'] == 0 and not record['stderr'], str(evidence) + '\n' + record['stderr'][:2400]
    expected = ['PORT source', 'PORT session', 'PORT lookup', 'PORT toml', 'PORT entries', 'PORT remember',
                'PORT source', 'PORT session', 'PORT lookup', 'PORT scope .', 'PORT guidance AGENTS.md',
                'PORT scope .', 'PORT scope src', 'PORT guidance src/AGENTS.md', 'PORT scope src',
                'PASS configuration cache and instruction application effects']
    assert record['stdout'].splitlines() == expected, record['stdout']
    trace = json.loads((state / 'controlled.trace.json').read_text())
    assert trace['outcome']['kind'] == 'completed' and not trace.get('incomplete', False)
    assert trace['termination']['local_work_settled'] is True
    starts = [event for event in trace['events'] if event['kind'] == 'host_request_started']
    ends = [event for event in trace['events'] if event['kind'] == 'host_request_finished']
    assert len(starts) == len(ends) and {event['id'] for event in starts} == {event['id'] for event in ends}
    assert all(event['outcome']['kind'] == 'succeeded' for event in ends)
    actions = {}
    for event in starts:
        name = event['qualified_action']
        actions[name] = actions.get(name, 0) + 1
    assert set(actions) <= {'Policy.evaluate', 'Memory.read', 'Memory.write', 'Console.stdout_write'}
    physical = record['physical']
    assert physical['exit'] == 0 and not physical['stderr'], physical
    assert physical['stdout'] == 'PASS physical project guidance\n', physical
    observed = json.loads((state / 'guidance.trace.json').read_text())
    assert observed['outcome']['kind'] == 'completed' and observed['termination']['local_work_settled'] is True
    reads = [event['qualified_action'] for event in observed['events'] if event['kind'] == 'host_request_started']
    assert set(reads) <= {'Policy.evaluate', 'Console.stdout_write', 'Fs.read', 'Fs.list'}
    assert reads.count('Fs.read') == 2 and reads.count('Fs.list') == 4
    assert (guidance / 'AGENTS.md').read_text() == 'Root guidance' and (guidance / 'src/AGENTS.md').read_text() == 'Scoped guidance'
    record['physical_host_actions'] = {name: reads.count(name) for name in set(reads)}
    resources = record['resources']
    assert resources['memory.max'] == '4294967296' and resources['cpu.max'] == '400000 100000' and resources['pids.max'] == '256'
    events = dict(line.split() for line in resources['memory.events'].splitlines())
    assert all(events[key] == '0' for key in ('max', 'oom', 'oom_kill', 'oom_group_kill'))
    record.update(status='passed', source_count=len(sources), paired_host_requests=len(starts), host_actions=actions,
                  qualification='One conversion/cache-hit sequence with real SQLite fixture state and history, and controlled root-to-leaf guidance for a proposed file. Controlled application flow performs no filesystem, command or model action. A separate existing production loader reads two real synthetic guide files in root-to-leaf order. This does not certify the proposed adapter migration.')
    (evidence / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    print('PASS configuration cache linkage and instruction effect ordering', flush=True)


if __name__ == '__main__':
    main()
