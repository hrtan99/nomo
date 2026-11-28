"""One shipping SQL image through the migration application and real native storage.

The controlled source qualifies the application/storage boundary independently of
the packet codec. --production compares the formal codec with that retained full
image. Fresh history uses the ordinary native product entry.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from native_sources import copy_sources
from native_memory_value import value as memory_value
from native_state_migration_probe import rows, audit
from native_recovery_probe import terminal, audit as audit_authority
from native_json import byte_values

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests/fixtures/legacy_project'))
sys.path.insert(0, str(ROOT / 'scripts'))
from nomo_history import SqliteHistory
from nomo_project import ProjectRegistry
from nomo_migration import project_packet, digest
from nomo_project import Workspace
from nomo_project_tools import BatchEditor
from nomo_jobs import ProcessService


def quote(value):
    return json.dumps(value, ensure_ascii=False)


def fixture(image):
    conversations = []
    for old in image['conversations']:
        events = ',\n'.join('ProjectEvent { id = ' + event['id'] + ', ' +
            ', '.join(name + ' = ' + quote(event[name]) for name in ('role', 'kind', 'name', 'text')) + ' }'
            for event in old['events'])
        conversations.append('ProjectConversation { ' +
            ', '.join(name + ' = ' + quote(old[name]) for name in ('id', 'workspace', 'title', 'summary', 'archive')) +
            ', compacted_through = ' + old['compacted_through'] + ', events = [' + events + '] }')
    edits = []
    for edit in image['edits']:
        paths = ['SavedPath { ' + ', '.join(name + ' = ' + quote(value) for name, value in saved.items()) + ' }'
                 for saved in edit['paths']]
        edits.append('ProjectEdit { ' + ', '.join(name + ' = ' + quote(edit[name])
                     for name in ('id', 'session', 'workspace', 'phase', 'archive')) + ', paths = [' + ', '.join(paths) + '] }')
    jobs = []
    for old in image['jobs']:
        record = ', '.join(name + ' = ' + quote(old[name]) for name in ('id', 'workspace', 'arguments', 'phase', 'original'))
        exit_code = 'None()' if old['exit_code']['tag'] == 'None' else 'Some(' + old['exit_code']['values'][0] + ')'
        chunks = ', '.join('from_array(' + quote(data) + ')' for data in old['chunks'])
        jobs.append('ProjectJob { record = ArchivedJob { ' + record + ', exit_code = ' + exit_code +
                    ', output_bytes = ' + old['output_bytes'] + ', parts = ' + str(len(old['chunks'])) +
                    ' }, chunks = [' + chunks + '] }')
    return '''module app.source;
import std.effects.Fs;
import std.fs.IOError as FileError;
import std.fs.ReadLimitError;
import std.bytes.from_array;
import nomo.application.transfer.ports.ProjectStateSource;
import nomo.application.resources.MigrationRoot;
import nomo.domain.archives.ProjectImage;
import nomo.domain.archives.ProjectConversation;
import nomo.domain.archives.ProjectEvent;
import nomo.domain.archives.ProjectEdit;
import nomo.domain.archives.ProjectJob;
import nomo.domain.processes.ArchivedJob;
import nomo.domain.changes.SavedPath;
public type FixtureSource = {};
impl FixtureSource ~ ProjectStateSource {
    flow load(self) -> ProjectImage ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>, Error<IndexError>] {
        return ProjectImage { source_sha256 = ''' + quote(image['source_sha256']) + ', projects = ' + quote(image['projects']) + ', conversations = [' + ',\n'.join(conversations) + '], edits = [' + ',\n'.join(edits) + '], jobs = [' + ',\n'.join(jobs) + '''] };
    }
}
'''


def interrupted_source(project, state, session):
    target = project / 'interrupted.txt'
    target.write_text('before old\n')
    target.chmod(0o751)
    program = '''import sys
from pathlib import Path
import nomo_project_tools as tools
from nomo_project import Workspace
restore = tools.restore
def retain(path, node):
    restore(path, node)
    print('source write retained', flush=True)
    sys.stdin.buffer.read(1)
tools.restore = retain
editor = tools.BatchEditor(Workspace(Path(sys.argv[1])), Path(sys.argv[2]), sys.argv[3])
editor.apply(editor.prepare([{'operation':'edit','path':'interrupted.txt','target':'old','text':'new'}]))
'''
    environment = dict(os.environ, PYTHONPATH=os.pathsep.join([str(ROOT / 'tests/fixtures/legacy_project'), str(ROOT / 'scripts')]))
    process = subprocess.Popen([sys.executable, '-B', '-c', program, str(project), str(state), session],
        env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert process.stdout.readline() == b'source write retained\n'
        assert target.read_bytes() == b'before new\n'
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate()
    journal, = [json.loads(path.read_text()) for path in (state / 'edits').glob('*.json')
                 if json.loads(path.read_text())['session'] == session]
    assert journal['phase'] == 'applying'


def source(evidence):
    first, second = evidence / 'project A', evidence / 'project 鹈鹕'
    first.mkdir()
    second.mkdir()
    history = SqliteHistory(evidence / 'original')
    older = history.create(first, 'Saved bicycle task')
    note = first / 'note.txt'
    note.write_text('before old\n')
    note.chmod(0o751)
    editor = BatchEditor(Workspace(first), history.state, older)
    applied = editor.apply(editor.prepare([
        {'operation': 'edit', 'path': 'note.txt', 'target': 'old', 'text': 'new'},
        {'operation': 'create', 'path': 'new/sub/readme.txt', 'text': '鹈鹕 café\n'},
    ]))
    history.append(older, 'user', 'Create a 鹈鹕 bicycle page.')
    history.append(older, 'assistant', '{"tool":"write"}', kind='action', name='write', data={'tool': 'write'})
    history.append(older, 'tool', 'Created index.html', name='write', data={'edit': 'old-edit-1', 'status': 'applied'})
    history.append(older, 'tool', json.dumps(applied), name='apply_changes', data=applied)
    history.append(older, 'assistant', '{"tool":"answer"}', kind='action', name='answer', data={'text': 'Page created.'})
    through = history.append(older, 'assistant', 'Page created.')
    history.compact(older, through, 'A bicycle page was created and checked.')
    history.append(older, 'user', 'Animate the wheels, preserving café text.')
    history.append(older, 'assistant', 'Animation request retained.')
    history.usage(older, {'prompt_tokens': 830, 'completion_tokens': 115})
    branch = history.fork(older)
    history.rename(branch, 'Saved fork')
    other = history.create(second, 'Another folder')
    history.append(other, 'user', 'Inspect the other project.')
    interrupted_source(second, history.state, other)
    service = ProcessService(history.state, first)
    job = service.start([sys.executable, '-B', '-c', 'import os; os.write(1, bytes([65, 0, 255, 10]))'])
    deadline = time.monotonic() + 10
    while job['status'] != 'completed' and time.monotonic() < deadline:
        time.sleep(0.02)
        job = {'job': job['job'], **service.poll(job['job'])}
    assert job['status'] == 'completed' and job['exit_code'] == 0
    assert (history.state / 'jobs' / job['job'] / 'output.log').read_bytes() == b'A\x00\xff\r\n'
    registry = ProjectRegistry(history.state)
    registry.touch(first)
    registry.touch(second)
    originals = {}
    for identifier in (older, branch, other):
        exported = evidence / (identifier + '.json')
        history.export(identifier, exported)
        originals[identifier] = json.loads(exported.read_text())
    return history.database, originals, older, first



def verify_projection(original, migrated):
    before = digest(original)
    history = SqliteHistory(original.parent)
    region = 'nomo-native-conversations-v1'
    sessions = history.sessions()
    messages = 0
    for old in sessions:
        identifier = old['id']
        current = migrated[(region, '["Sessions"]', identifier)]
        projected = []
        for index in range(current['summary_through'] + 1, current['next_event']):
            key = identifier + ':' + str(index)
            event = migrated[(region, '["Events"]', key)]
            if event['role'] in ('summary', 'archive'):
                continue
            text = ''.join(migrated[(region, '["Chunks"]', key + ':' + str(part))]
                           for part in range(event['chunks']))
            projected.append({'role': event['role'], 'name': event['name'], 'content': text})
        expected = history.context(identifier)
        if old['summary']:
            expected = expected[1:]  # Native context carries the selected summary separately.
        assert projected == [{name: event[name] for name in ('role', 'name', 'content')} for event in expected]
        messages += len(expected)
    assert digest(original) == before
    return {'sessions': len(sessions), 'context_messages': messages, 'matches_shipping_projection': True}


def restore_imported(evidence, environment, project, edit, operation):
    commands = []
    for saved in reversed(edit['paths']):
        if saved['after_exists']:
            if operation == 'undo':
                commands.append({'program': '/usr/bin/diff', 'arguments': ['-r', '--no-dereference', '--', saved['path'], saved['after']]})
            commands.append({'program': '/bin/rm', 'arguments': ['-rf', '--', saved['path']]})
        if saved['before_exists']:
            commands.append({'program': '/bin/cp', 'arguments': ['-a', '--', saved['before'], saved['path']]})
    approved = []

    def approve(output):
        line = next(line for line in reversed(output.decode().splitlines()) if '[COMMAND] ' in line)
        preview = json.loads(line.split('[COMMAND] ', 1)[1])
        assert preview == commands[len(approved)], preview
        approved.append(preview)

    command = [str(ROOT / 'scripts/nomo-native'), str(project), '--id', edit['session']]
    code, output, approvals, _ = terminal(command, environment,
        ['/edits', '/' + operation + ' ' + edit['id'], '/edits', '/status', '/quit'], project, approve=approve)
    (evidence / (operation + '-terminal.txt')).write_text(output)
    assert code == 0 and approvals == len(commands) == len(approved), output
    before, after = ('applied', 'undone') if operation == 'undo' else ('interrupted', 'rolled_back')
    assert '"phase":"' + before + '"' in output and '"phase":"' + after + '"' in output
    target = 'note.txt' if operation == 'undo' else 'interrupted.txt'
    assert (project / target).read_bytes() == b'before old\n'
    assert (project / target).stat().st_mode & 0o777 == 0o751
    assert not (project / 'new').exists()
    trace_path, = list((evidence / (operation + '-traces')).glob('run-*/trace.json'))
    trace = json.loads(trace_path.read_text())
    assert trace['outcome']['kind'] == 'completed' and trace['termination']['local_work_settled']
    starts = {event['id']: event for event in trace['events'] if event['kind'] == 'host_request_started'}
    ends = {event['id']: event for event in trace['events'] if event['kind'] == 'host_request_finished'}
    assert starts.keys() == ends.keys() and all(event['outcome']['kind'] == 'succeeded' for event in ends.values())
    assert not audit_authority(trace['events'])
    assert not any(event.get('request_kind') == 'model' for event in starts.values())
    assert sum(event['qualified_action'] == 'Command.run' for event in starts.values()) == len(commands)
    migrated = rows(Path(environment['NOMO_NATIVE_STATE']) / 'conversations.sqlite3', memory_value)
    journal = migrated[('nomo-native-file-journals-v1', '["Journals"]', edit['id'])]
    assert journal['phase'] == after and journal['owner_name'] == operation + '_changes'
    assert journal['owner_call'] > journal['call']
    request = migrated[('nomo-native-conversations-v1', '["Events"]', edit['session'] + ':' + str(journal['owner_call']))]
    assert request['role'] == 'tool_call' and request['name'] == operation + '_changes'
    assert migrated[('nomo-native-conversations-v1', '["Sessions"]', edit['session'])]['pending'] == ''
    return {'status': 'passed', 'edit': edit['id'], 'native_approvals': approvals,
            'command_actions': len(commands), 'paired_host_requests': len(starts),
            'authority_audit': 'passed', 'model_requests': 0,
            'restored': [target + ' bytes', target + ' mode 0751'] +
                        (['absence of created new/ subtree'] if operation == 'undo' else [])}


def production(retained, destination):
    """Qualify the formal codec against the already accepted complete typed image."""
    retained, destination = retained.resolve(), destination.resolve()
    source = retained / 'original/project.sqlite3'
    before = digest(source)
    expected = json.loads((retained / 'migration-values.json').read_text())
    environment = dict(os.environ, NOMO_NATIVE_UID=str(os.getuid()), NOMO_NATIVE_GID=str(os.getgid()))
    command = [str(ROOT / 'scripts/nomo-migrate-native'), '--from', 'project', str(source), str(destination)]
    run = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, text=True)
    (retained / (destination.name + '-driver.txt')).write_text(run.stdout + run.stderr)
    assert run.returncode == 0, run.stdout + run.stderr
    receipt = json.loads((destination / 'migration.json').read_text())
    assert receipt['status'] == 'completed' and receipt['source_database_sha256'] == before == digest(source)
    actual = rows(destination / 'state/conversations.sqlite3', memory_value)
    normalized = json.loads(json.dumps([{'region': region, 'store': store, 'key': key, 'value': value}
        for (region, store, key), value in sorted(actual.items())], default=list))
    assert normalized == expected, 'formal packet conversion differs from the complete typed-source result'
    migration_requests = audit(destination / 'trace/trace.json')
    image = json.loads((retained / 'input/snapshot.json').read_text())
    conversation = next(old for old in image['conversations'] if old['title'] == 'Saved bicycle task')
    environment.update(MINIMAX_API_KEY='unused-no-model', NOMO_NATIVE_STATE=str(destination / 'state'),
                       NOMO_NATIVE_TRACE_ROOT=str(destination / 'history-traces'))
    history = subprocess.run([str(ROOT / 'scripts/nomo-native'), conversation['workspace'], '--id', conversation['id'], '--history'],
                             cwd=ROOT, env=environment, capture_output=True, text=True)
    (destination / 'fresh-history.txt').write_text(history.stdout + history.stderr)
    assert history.returncode == 0, history.stdout + history.stderr
    assert all(event['text'] in history.stdout for event in conversation['events'])
    history_requests = sum(audit(path) for path in (destination / 'history-traces').glob('run-*/trace.json'))
    result = {'status': 'passed-formal-codec-all-rows-and-fresh-history', 'source': str(source),
              'source_sha256': before, 'source_unchanged': True, 'business_rows_compared': len(expected),
              'source_rows': receipt['rows'], 'migration_host_requests': migration_requests,
              'fresh_history_host_requests': history_requests, 'model_requests': 0,
              'command_actions': 0, 'retained_reference': str(retained)}
    (destination / 'qualification.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS formal project packet, all business rows and fresh history: ' + str(destination), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--production', nargs=2, type=Path, metavar=('RETAINED_EVIDENCE', 'NEW_DESTINATION'),
                        help='run the formal codec once against an existing accepted typed image, without repeating its producer or edits')
    arguments = parser.parse_args()
    if arguments.production:
        production(*arguments.production)
        return
    evidence = Path(tempfile.mkdtemp(prefix='nomo-project-state-migration-')).resolve()
    original, expected, selected_id, project = source(evidence)
    before = digest(original)
    incoming = evidence / 'input'
    incoming.mkdir()
    state, package = evidence / 'state', evidence / 'package'
    state.mkdir()
    package.mkdir()
    image = project_packet(original, incoming / 'legacy-source.sqlite3', state)
    for old in image['conversations']:
        assert json.loads(old['archive']) == expected[old['id']]
    assert digest(original) == before
    (incoming / 'snapshot.json').write_text(json.dumps(image, ensure_ascii=False) + '\n')
    (package / '.etas').mkdir()
    copied = copy_sources(ROOT, package, ROOT / 'tests/fixtures/native_project_migration/src/app/main.es')
    generated = package / 'src/app/source.es'
    generated.write_text(fixture(image))
    copied['generated:src/app/source.es'] = hashlib.sha256(generated.read_bytes()).hexdigest()
    (evidence / 'sources.json').write_text(json.dumps(copied, indent=2) + '\n')
    (package / 'etas.toml').write_text('''[package]
name = "nomo"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.memory]
backend = "sqlite"
path = "/state/conversations.sqlite3"
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["console=allow", "memory=allow", "filesystem:Fs.read=allow"]
[runtime.profiles.local.filesystem.regions."nomo.application.resources.MigrationRoot"]
root = "/migration"
read = true
write = false
[[bin]]
name = "native-project-migration"
module = "app.main"
flow = "main"
''')
    (package / 'etas.lock').write_text('version = 1\nmanifest_fingerprint = "etas-lock-input:v1|package=nomo|version=0.1.0|edition=2026"\npackage = []\n')
    overlay = evidence / 'compose.json'
    overlay.write_text(json.dumps({'services': {'dev': {'volumes': [
        {'type': 'bind', 'source': str(package), 'target': '/workspace', 'read_only': True},
        {'type': 'bind', 'source': str(state), 'target': '/state'},
        {'type': 'bind', 'source': str(incoming), 'target': '/migration', 'read_only': True}]}}}))
    command = ['docker', 'compose', '--env-file', '/dev/null']
    for name in ('compose.yaml', 'config/etas-02413-official-compose.yaml', 'config/etas-runtime-cache-compose.yaml',
                 'config/nomo-native-launch-compose.yaml', str(overlay)):
        command += ['--file', str(ROOT / name)]
    command += ['run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', 'dev',
                '/home/nomo/.cargo/bin/etas', '--no-config', '--cache', 'off', 'run', '/workspace',
                '--allow-effects', '--trace-out', '/state/migration.trace.json']
    environment = dict(os.environ, NOMO_NATIVE_UID=str(os.getuid()), NOMO_NATIVE_GID=str(os.getgid()))
    print('EVIDENCE ' + str(evidence), flush=True)
    run = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, text=True)
    (evidence / 'stdout.txt').write_text(run.stdout)
    (evidence / 'stderr.txt').write_text(run.stderr)
    assert run.returncode == 0, run.stdout + run.stderr
    report = json.loads(run.stdout)
    assert report == {'source_sha256': image['source_sha256'], 'rows': sum(1 + len(old['events']) for old in image['conversations']) + len(image['edits']) + len(image['jobs'])}
    migrated = rows(state / 'conversations.sqlite3', memory_value)
    (evidence / 'migration-values.json').write_text(json.dumps([
        {'region': region, 'store': store, 'key': key, 'value': value}
        for (region, store, key), value in sorted(migrated.items())], indent=2, default=list) + '\n')
    region = 'nomo-native-conversations-v1'

    def text(identifier, index):
        event = migrated[(region, '["Events"]', identifier + ':' + str(index))]
        assert event['complete']
        return ''.join(migrated[(region, '["Chunks"]', identifier + ':' + str(index) + ':' + str(part))]
                       for part in range(event['chunks']))

    for identifier, old in expected.items():
        current = migrated[(region, '["Sessions"]', identifier)]
        assert current['id'] == identifier and current['workspace'] == old['session']['root']
        assert current['title'] == old['session']['title'] and current['pending'] == ''
        assert json.loads(text(identifier, 0)) == old
        for index, event in enumerate(old['events'], 1):
            assert text(identifier, index) == event['content']
        assert current['first_user'] == next(i for i, event in enumerate(old['events'], 1) if event['role'] == 'user')
        if old['session']['summary']:
            assert text(identifier, current['summary_event']) == old['session']['summary']
            fence = max(i for i, event in enumerate(old['events'], 1) if event['id'] <= old['session']['compacted_through'])
            assert current['summary_through'] == fence
        else:
            assert current['summary_event'] == -1 and current['summary_through'] == -1
        assert all(value == 0 for value in current['ledger'].values())
    projection = verify_projection(original, migrated)
    assert len(image['edits']) == 2
    for edit in image['edits']:
        journal = migrated[('nomo-native-file-journals-v1', '["Journals"]', edit['id'])]
        assert journal['session'] == edit['session'] and journal['phase'] == ('applied' if edit['phase'] == 'applied' else 'interrupted')
        assert journal['steps'] == len(edit['paths']) and journal['owner_call'] == journal['call']
        assert json.loads(text(edit['session'], journal['call'])) == json.loads(edit['archive'])
        assert migrated[(region, '["Events"]', edit['session'] + ':' + str(journal['call']))]['role'] == 'archive'
        for index, saved in enumerate(edit['paths']):
            assert migrated[('nomo-native-file-journals-v1', '["Steps"]', edit['id'] + '/' + str(index))] == {
                'phase': edit['phase'], 'paths': [saved]}
    edit, = [edit for edit in image['edits'] if edit['session'] == selected_id]
    for workspace in {old['session']['root'] for old in expected.values()}:
        newest = max((old for old in expected.values() if old['session']['root'] == workspace), key=lambda old: old['session']['updated'])
        assert migrated[(region, '["Selected"]', workspace)] == newest['session']['id']
    assert migrated[('nomo-native-projects-v1', '["Recent"]', 'folders')] == image['projects']
    requests = audit(state / 'migration.trace.json')
    job, = image['jobs']
    archive_region = 'nomo-native-project-jobs-v1'
    saved_job = migrated[(archive_region, '["Jobs"]', job['id'])]
    assert saved_job == {name: job[name] for name in ('id', 'workspace', 'arguments', 'phase', 'original')} | {
        'exit_code': {'name': 'Some', 'fields': [0]}, 'output_bytes': 5, 'parts': 1}
    assert migrated[(archive_region, '["Parts"]', job['id'] + '/0')] == b'A\x00\xff\r\n'
    assert not any(region == 'nomo-native-processes-v1' for region, _, _ in migrated)
    fresh_environment = dict(environment, MINIMAX_API_KEY='unused-no-model', NOMO_NATIVE_STATE=str(state),
                             NOMO_NATIVE_TRACE_ROOT=str(evidence / 'restore-traces'))
    restored = {}
    for flag in ('--status', '--history'):
        result = subprocess.run([str(ROOT / 'scripts/nomo-native'), str(project), '--id', selected_id, flag],
                                cwd=ROOT, env=fresh_environment, capture_output=True, text=True)
        (evidence / (flag[2:] + '.txt')).write_text(result.stdout + result.stderr)
        assert result.returncode == 0, result.stdout + result.stderr
        restored[flag] = result.stdout
    status = json.loads(next(line.split('[STATUS ] ', 1)[1] for line in restored['--status'].splitlines() if '[STATUS ] {' in line))
    assert status == migrated[(region, '["Sessions"]', selected_id)]
    for event in expected[selected_id]['events']:
        assert event['content'] in restored['--history']
    restore_requests = sum(audit(path) for path in (evidence / 'restore-traces').glob('run-*/trace.json'))
    job_environment = dict(fresh_environment, NOMO_NATIVE_TRACE_ROOT=str(evidence / 'job-traces'))
    code, output, approvals, _ = terminal([str(ROOT / 'scripts/nomo-native'), str(project), '--id', selected_id],
        job_environment, ['/jobs', '/archived-output ' + job['id'], '/quit'], project)
    (evidence / 'archived-job-terminal.txt').write_text(output)
    assert code == 0 and approvals == 0, output
    listed = json.loads(next(line.split('[OLD JOB] ', 1)[1] for line in output.splitlines() if '[OLD JOB] {' in line))
    archived = json.loads(next(line.split('[OLD OUT] ', 1)[1] for line in output.splitlines() if '[OLD OUT] {' in line))
    assert listed['id'] == job['id'] and listed['workspace'] == str(project) and listed['phase'] == 'completed'
    assert 'handle' not in listed and 'session' not in listed
    assert archived['job'] == job['id'] and archived['part'] == 0 and archived['next_part'] == {'name': 'None', 'fields': []} and archived['total_bytes'] == 5
    assert byte_values(archived['data']) == b'A\x00\xff\r\n'
    job_requests = sum(audit(path) for path in (evidence / 'job-traces').glob('run-*/trace.json'))
    assert (original.parent / 'jobs' / job['id'] / 'status.json').read_text() == job['original']
    assert (original.parent / 'jobs' / job['id'] / 'output.log').read_bytes() == b'A\x00\xff\r\n'
    assert (project / 'note.txt').read_bytes() == b'before new\n'
    assert (project / 'new/sub/readme.txt').read_text() == '鹈鹕 café\n'
    undo_environment = dict(fresh_environment, NOMO_NATIVE_TRACE_ROOT=str(evidence / 'undo-traces'))
    undone = restore_imported(evidence, undo_environment, project, edit, 'undo')
    interrupted, = [edit for edit in image['edits'] if edit['phase'] == 'applying']
    rollback_environment = dict(fresh_environment, NOMO_NATIVE_TRACE_ROOT=str(evidence / 'rollback-traces'))
    rolled_back = restore_imported(evidence, rollback_environment, Path(interrupted['workspace']), interrupted, 'rollback')
    for edit in image['edits']:
        assert (original.parent / 'edits' / (edit['id'] + '.json')).read_text() == edit['archive']
    assert digest(original) == before
    record = {'status': 'passed-application-and-real-storage', 'source': str(original), 'source_sha256': before,
              'original_sessions': len(expected), 'original_rows': report['rows'], 'source_unchanged': True, 'projection': projection,
              'migration_host_requests': requests, 'fresh_status_history_host_requests': restore_requests,
              'workspace_job_archive': {'id': job['id'], 'workspace': job['workspace'], 'raw_bytes': 5,
                  'fresh_terminal_host_requests': job_requests, 'native_approvals': approvals,
                  'fabricated_native_handles': 0, 'source_files_unchanged': True},
              'real_provider_requests': 0, 'migration_command_actions': 0, 'native_undo': undone, 'native_rollback': rolled_back,
              'qualification': 'One actual shipping SQL image generated through its public history/compaction/fork APIs. '
                  'The read-only source adapter matches complete original exports. A controlled typed source exercises '
                  'the production migration application, NativeStateWriter and historical append, followed by ordinary '
                  'fresh native status/history, an explicit native undo and explicit rollback of two actual owned BatchEditor journals. '
                  'A real completed shipping PTY job is imported with workspace ownership and exact raw output, '
                  'then listed and read through the fresh native terminal with no model or command action. '
                  'Original journals and job files remain exact. The old edit format does not preserve directory modes, timestamps or links. '
                  'This does not qualify the production packet JSON codec, '
                  'bounded legacy sessions or default cutover.'}
    (evidence / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    print('PASS project migration policy, original archives and fresh native history: ' + str(evidence), flush=True)


if __name__ == '__main__':
    main()
