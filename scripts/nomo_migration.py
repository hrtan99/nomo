"""Read-only source adapters for one-time saved-state migration."""
import hashlib
import json
import shutil
import sqlite3

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


def project_packet(source, archive):
    """Export the complete shipping SQL rows plus the native consumer's view."""
    backup(source, archive)
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
    return {'format': 'nomo-project-state-1', 'source_sha256': digest(archive),
            'projects': projects, 'conversations': conversations}
