"""Read-only source adapters for one-time saved-state migration."""
import base64
import hashlib
import json
from pathlib import PurePosixPath
import shutil
import sqlite3
import tarfile
import tempfile

STORES = {
    'nomo-native-conversations-v1': ('conversations', ('Counters', 'Selected', 'Sessions', 'Events', 'Chunks')),
    'nomo-native-conversation-copies-v1': ('copies', ('Jobs',)),
    'nomo-native-attempts-v1': ('attempts', ('Counter', 'Attempts')),
    'nomo-native-configuration-v1': ('configuration', ('Parsed',)),
    'nomo-native-projects-v1': ('projects', ('Recent',)),
    'nomo-native-file-journals-v1': ('mutations', ('Journals', 'Steps')),
    'nomo-native-processes-v1': ('processes', ('Jobs', 'Outputs')),
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def legacy_value(value):
    """Decode the old public HostEncodedValue envelope, without re-encoding Memory bytes."""
    kind = value['kind']
    if kind in ('string', 'bool', 'bytes'):
        return value['value']
    if kind in ('int', 'uint'):
        return str(value['value'])
    if kind == 'list':
        return [legacy_value(item) for item in value['items']]
    if kind == 'record':
        return {item['name']: legacy_value(item['value']) for item in value['fields']}
    if kind == 'variant':
        return {'tag': value['name'], 'values': [legacy_value(item) for item in value['fields']]}
    raise ValueError('unsupported native 0.13.5 value kind: ' + kind)


def native_packet(source, archive):
    """Read a coherent SQLite backup; keep all original stores and receipts in that backup."""
    backup(source, archive)
    rows = []
    with sqlite3.connect(archive.as_uri() + '?mode=ro', uri=True) as db:
        version, = db.execute('SELECT format FROM etas_memory_schema WHERE id=1').fetchone()
        if version != 3:
            raise ValueError('this migration accepts native SQLite format 3 only')
        for region, path in db.execute('SELECT region,path FROM memory_stores'):
            prefix, paths = STORES[region]
            if json.loads(path) not in [[name] for name in paths]:
                raise ValueError('unsupported native store: ' + region + ' ' + path)
        for region, path, key, value in db.execute(
                'SELECT region,path,key_json,value_json FROM memory_entries ORDER BY region,path,key_json'):
            prefix, _ = STORES[region]
            key = legacy_value(json.loads(key))
            if not isinstance(key, str):
                raise ValueError('native store key must be a string')
            rows.append({'store': prefix + '.' + json.loads(path)[0], 'key': key,
                         'value': json.dumps(legacy_value(json.loads(value)), ensure_ascii=False, separators=(',', ':'))})
    return {'format': 'nomo-native-state-0135-v1', 'source_sha256': digest(archive), 'rows': rows}



def backup(source, archive):
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as old:
        with sqlite3.connect(archive) as snapshot:
            old.backup(snapshot)
    archive.chmod(0o600)


def _retain_tree(source, destination, name):
    """Copy a quiescent source tree, preserving its filesystem object metadata."""
    # A locally produced tar preserves modes, symlinks and hard-link groups;
    # no foreign archive is extracted. The temporary stream is deleted on close.
    with tempfile.TemporaryFile() as stream:
        with tarfile.open(fileobj=stream, mode='w') as archive:
            archive.add(source.resolve(), arcname=name)
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode='r') as archive:
            archive.extractall(destination, filter='fully_trusted')
    # Tar timestamps use floating-point seconds. Retain exact nanoseconds and
    # platform metadata after copying the objects.
    for original in [source, *source.rglob('*')]:
        shutil.copystat(original, destination / name / original.relative_to(source), follow_symlinks=False)


def native_snapshots(source, image, state):
    """Retain the filesystem objects referenced by the old native edit rows."""
    edits = source.parent / 'edits'
    copied = []
    if edits.exists():
        _retain_tree(edits, state, 'edits')
        copied.append('edits')
    references = set()
    for row in image['rows']:
        if row['store'] != 'mutations.Steps':
            continue
        for saved in json.loads(row['value'])['paths']:
            for side in ('before', 'after'):
                if saved[side + '_exists']:
                    relative = PurePosixPath(saved[side]).relative_to('/native-state')
                    target = state.joinpath(*relative.parts)
                    if not target.exists() and not target.is_symlink():
                        raise FileNotFoundError('native edit snapshot is missing: ' + saved[side])
                    references.add(str(relative))
    return {'directories': copied, 'referenced_snapshots': len(references)}


def _project_files(source, directory):
    """Retain old editor journals and job files without importing native authority.

    The old Nomo and its background job writers must be stopped before copying.
    Process metadata belongs to a workspace, not an inferred conversation.
    """
    retained = []
    files = {}
    for name in ('edits', 'jobs'):
        original = source.parent / name
        if not original.exists():
            continue
        _retain_tree(original, directory, name)
        retained.append(name)
        for path in sorted((directory / name).rglob('*')):
            relative = path.relative_to(directory).as_posix()
            if path.is_symlink():
                files[relative] = {'link': str(path.readlink())}
            elif path.is_file():
                files[relative] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
    manifest = {'format': 'nomo-project-files-1', 'directories': retained, 'files': files,
                'native_import': 'not-performed',
                'scope': 'Original edit snapshots, job status and raw output only. '
                         'No native edit journal, job ownership, live handle or completed outcome is synthesized.'}
    (directory / 'project-files.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def _materialize_node(path, node):
    """Decode an old embedded snapshot into the fresh destination snapshot area."""
    if node is None:
        return
    if 'directory' in node:
        path.mkdir()
        for name, child in node['directory'].items():
            _materialize_node(path / name, child)
    else:
        path.write_bytes(base64.b64decode(node['bytes']))
        path.chmod(node['mode'])


def _project_edits(directory, conversations, state):
    owners = {(old['id'], old['workspace']) for old in conversations}
    edits, unowned = [], []
    journals = sorted((directory / 'edits').glob('*.json'), key=lambda path: (path.stat().st_mtime_ns, path.name))
    for path in journals:
        original = path.read_text()
        old = json.loads(original)
        if (old['session'], old['root']) not in owners:
            unowned.append(path.name)
            continue
        snapshots = state / 'edits' / old['id']
        snapshots.mkdir(parents=True)
        paths = []
        for index, step in enumerate(old['steps']):
            stem = str(index) + '-0'
            saved = {'path': step['path']}
            for side in ('before', 'after'):
                saved[side + '_exists'] = step[side] is not None
                saved[side] = '/native-state/edits/' + old['id'] + '/' + stem + '.' + side
                if step[side] is not None:
                    _materialize_node(snapshots / (stem + '.' + side), step[side])
            paths.append(saved)
        edits.append({'id': old['id'], 'session': old['session'], 'workspace': old['root'],
                      'phase': old['phase'], 'archive': original, 'paths': paths})
    return edits, unowned


def _project_jobs(directory):
    """Read workspace ownership and raw merged PTY output from the retained copy."""
    jobs = []
    for path in sorted((directory / 'jobs').glob('*/status.json')):
        original = path.read_text()
        saved = json.loads(original)
        chunks = []
        size = 0
        with (path.parent / 'output.log').open('rb') as stream:
            while data := stream.read(262144):
                chunks.append(list(data))
                size += len(data)
        jobs.append({'id': path.parent.name, 'workspace': saved['root'], 'arguments': saved['arguments'],
                     'phase': saved['status'], 'exit_code': None if saved['exit_code'] is None else str(saved['exit_code']),
                     'output_bytes': str(size), 'original': original, 'chunks': chunks})
    return jobs


def project_packet(source, archive, state):
    """Export the complete shipping SQL rows plus the native consumer's view."""
    backup(source, archive)
    manifest = _project_files(source, archive.parent)
    registry = source.parent / 'projects.json'
    projects = []
    if registry.is_file():
        saved = archive.parent / 'projects.json'
        shutil.copyfile(registry, saved)
        saved.chmod(0o600)
        projects = [row['root'] for row in json.loads(saved.read_text())]
    conversations = []
    with sqlite3.connect(archive.as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        sessions = db.execute('SELECT * FROM projects_sessions ORDER BY updated DESC').fetchall()
        for row in sessions:
            events = []
            for item in db.execute('SELECT * FROM projects_events WHERE session=? ORDER BY id', (row['id'],)):
                event = dict(item)
                event['data'] = json.loads(event['data'])
                events.append(event)
            original = {'format': 'nomo-conversation-1', 'session': dict(row), 'events': events}
            conversations.append({
                'id': row['id'], 'workspace': row['root'], 'title': row['title'],
                'compacted_through': str(row['compacted_through']), 'summary': row['summary'],
                'archive': json.dumps(original, ensure_ascii=False, separators=(',', ':')),
                'events': [{'id': str(event['id']), 'role': event['role'], 'kind': event['kind'],
                            'name': event['name'], 'text': event['content']} for event in events],
            })
    edits, unowned = _project_edits(archive.parent, conversations, state)
    jobs = _project_jobs(archive.parent)
    manifest.update(prepared_edits=[edit['id'] for edit in edits], unowned_edits=unowned,
                    prepared_jobs=[job['id'] for job in jobs])
    (archive.parent / 'project-files.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return {'format': 'nomo-project-state-3', 'source_sha256': digest(archive),
            'projects': projects, 'conversations': conversations, 'edits': edits, 'jobs': jobs}
