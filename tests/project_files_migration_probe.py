"""One actual shipping edit/job source backup; no native import or model claim."""
import json
from pathlib import Path
import sys
import tempfile
import time

from native_state_migration_probe import snapshot_tree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from nomo_history import SqliteHistory
from nomo_jobs import ProcessService
from nomo_migration import project_packet, digest
from nomo_project import ProjectRegistry, Workspace
from nomo_project_tools import BatchEditor


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-project-files-migration-')).resolve()
    project, state, archive = (evidence / name for name in ('project', 'source', 'archive'))
    project.mkdir()
    archive.mkdir(mode=0o700)
    original = project / 'note.txt'
    original.write_text('before old\n')
    original.chmod(0o751)
    history = SqliteHistory(state)
    session = history.create(project, 'Migration source')
    ProjectRegistry(state).touch(project)
    history.append(session, 'user', 'Change old to new and create the related file.')
    editor = BatchEditor(Workspace(project), state, session)
    changes = [{'operation': 'edit', 'path': 'note.txt', 'target': 'old', 'text': 'new'},
               {'operation': 'create', 'path': 'new/sub/readme.txt', 'text': '鹈鹕 café\n'}]
    applied = editor.apply(editor.prepare(changes))
    history.append(session, 'tool', json.dumps(applied), name='apply_changes', data=applied)
    jobs = ProcessService(state, project)
    job = jobs.start([sys.executable, '-c', 'import os; os.write(1, bytes([65,0,255,10]))'])
    deadline = time.monotonic() + 15
    while job['status'] != 'completed':
        if time.monotonic() >= deadline:
            raise AssertionError('synthetic source job did not finish')
        time.sleep(0.02)
        job = {'job': job['job'], **jobs.poll(job['job'])}
    assert job['exit_code'] == 0, job
    raw = state / 'jobs' / job['job'] / 'output.log'
    assert 0 in raw.read_bytes() and 255 in raw.read_bytes()
    trees = {name: snapshot_tree(state / name) for name in ('edits', 'jobs')}
    workspace = snapshot_tree(project)
    database, registry = digest(history.database), (state / 'projects.json').read_bytes()
    native = evidence / 'native-state'
    native.mkdir()
    image = project_packet(history.database, archive / 'legacy-source.sqlite3', native)
    manifest = json.loads((archive / 'project-files.json').read_text())
    assert image['format'] == 'nomo-project-state-2' and image['conversations'][0]['id'] == session
    assert image['conversations'][0]['events'][-1]['name'] == 'apply_changes'
    assert manifest['native_import'] == 'not-performed' and manifest['directories'] == ['edits', 'jobs']
    assert set(manifest['files']) == {path.relative_to(state).as_posix()
        for name in ('edits', 'jobs') for path in (state / name).rglob('*') if path.is_file()}
    for relative, record in manifest['files'].items():
        assert digest(state / relative) == record['sha256'] == digest(archive / relative)
        assert (archive / relative).stat().st_size == record['bytes']
    for name, expected in trees.items():
        assert snapshot_tree(state / name) == snapshot_tree(archive / name) == expected, name
    assert snapshot_tree(project) == workspace
    assert digest(history.database) == database and (state / 'projects.json').read_bytes() == registry
    record = {'status': 'passed', 'evidence': str(evidence), 'source_sha256': database,
              'source_after_sha256': digest(history.database), 'edit': applied['edit'], 'source_job': job,
              'source_trees': trees, 'backup_manifest': manifest,
              'qualification': 'Real BatchEditor journal with embedded before/after bytes, real completed ProcessService job with binary PTY output. Exact bytes, modes, nanosecond mtimes and link groups preserved; source SQL/registry/trees/workspace unchanged. This is source backup only, not native journal/job conversion, undo or live process reconnection.'}
    (evidence / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    print('PASS actual shipping edit/job source backup: ' + str(evidence))


if __name__ == '__main__':
    main()
