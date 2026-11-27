"""Application mutation ordering with real fixture journals and controlled file effects."""
from pathlib import Path
from native_sources import copy_sources
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-native-mutation-controller-')).resolve()
    package, state = evidence / 'package', evidence / 'state'
    package.mkdir()
    (package / '.etas').mkdir()
    state.mkdir(mode=0o777)
    state.chmod(0o777)
    fixture = ROOT / 'tests/fixtures/native_mutation_controller/src/app/main.es'
    sources = copy_sources(ROOT, package, fixture)
    (evidence / 'sources.json').write_text(json.dumps(sources, indent=2) + '\n')
    (package / 'etas.toml').write_text('''[package]
name = "native-mutation-controller"
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
rules = ["memory=allow", "console=allow"]
[[bin]]
name = "native-mutation-controller"
module = "app.main"
flow = "main"
''')
    (package / 'etas.lock').write_text('version = 1\nmanifest_fingerprint = "etas-lock-input:v1|package=native-mutation-controller|version=0.1.0|edition=2026"\npackage = []\n')
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {'volumes': [
        {'type': 'bind', 'source': str(package), 'target': '/workspace', 'read_only': True},
        {'type': 'bind', 'source': str(state), 'target': '/state'}]}}}))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-0249-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    inside = '''import json,pathlib,subprocess
cmd=['/home/nomo/.cargo/bin/etas','--no-config','--cache','off','run','/workspace','--allow-effects','--trace-out','/state/mutations.trace.json']
p=subprocess.run(cmd,capture_output=True,text=True)
r={name:(pathlib.Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
print(json.dumps({'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'resources':r}))'''
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev', 'python3', '-c', inside]
    print('EVIDENCE ' + str(evidence), flush=True)
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=300)
    (evidence / 'container-stderr.txt').write_text(result.stderr)
    assert result.returncode == 0, result.stderr
    record = json.loads(result.stdout)
    (evidence / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    assert record['exit'] == 0 and not record['stderr'], str(evidence) + '\n' + record['stderr'][:2400]
    selected = [line for line in record['stdout'].splitlines() if line.startswith(('PORT ', 'PASS '))]
    assert selected == ['PORT write after durable recovery metadata', 'PASS controlled apply and undo',
                        'PORT write after durable recovery metadata', 'PORT after-write snapshot failed',
                        'PORT partial write retained', 'PASS controlled explicit rollback after write'], selected
    trace = json.loads((state / 'mutations.trace.json').read_text())
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
    resources = record['resources']
    assert resources['memory.max'] == '4294967296' and resources['cpu.max'] == '400000 100000' and resources['pids.max'] == '256'
    events = dict(line.split() for line in resources['memory.events'].splitlines())
    assert all(events[key] == '0' for key in ('max', 'oom', 'oom_kill', 'oom_group_kill'))
    record.update(status='passed', source_count=len(sources), paired_host_requests=len(starts), host_actions=actions,
                  qualification='Apply/undo and explicitly required recovery after a retained write. Actual NativeChangeJournals and real SQLite history with controlled file/command effects. This does not certify actual project filesystem writes, on-disk rollback or native approvals.')
    (evidence / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    print('PASS application mutation ordering, undo and retained-write rollback', flush=True)


if __name__ == '__main__':
    main()
