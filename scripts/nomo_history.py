"""Complete conversation archive; model context is a separate projection."""
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Protocol
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import time


class ConversationStore(Protocol):
    def append(self, session, role, content, kind='message', name='', data=None): ...
    def events(self, session, query=''): ...
    def sessions(self, root=None): ...
    def fork(self, session, through=None): ...
    def export(self, session, destination): ...


class SqliteHistory:
    def __init__(self, state):
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = self.state / 'project.sqlite3'
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS projects_sessions (
                    id TEXT PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL,
                    created REAL NOT NULL, updated REAL NOT NULL, parent TEXT,
                    compacted_through INTEGER NOT NULL DEFAULT 0,
                    summary TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL DEFAULT '{}');
                CREATE TABLE IF NOT EXISTS projects_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL,
                    role TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
                    content TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS projects_events_session ON projects_events(session,id);
            ''')
        self.database.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, root, title='New conversation', parent=None, identifier=None):
        identifier, now = identifier or secrets.token_hex(16), time.time()
        with self.connect() as db:
            db.execute('INSERT INTO projects_sessions(id,root,title,created,updated,parent) VALUES(?,?,?,?,?,?)',
                       (identifier, str(Path(root).resolve()), title, now, now, parent))
        return identifier

    def session(self, identifier, root=None):
        with self.connect() as db:
            row = db.execute('SELECT * FROM projects_sessions WHERE id=?', (identifier,)).fetchone()
        if row is None:
            self.import_legacy(identifier, root)
            return self.session(identifier)
        return dict(row)

    def sessions(self, root=None):
        with self.connect() as db:
            rows = db.execute('SELECT * FROM projects_sessions' + (' WHERE root=?' if root else '') + ' ORDER BY updated DESC',
                              (str(Path(root).resolve()),) if root else ()).fetchall()
        result = []
        for row in rows:
            value = dict(row)
            with self.connect() as db:
                latest = db.execute("SELECT substr(content,1,120) FROM projects_events WHERE session=? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1", (row['id'],)).fetchone()
                value['messages'] = db.execute('SELECT count(*) FROM projects_events WHERE session=?', (row['id'],)).fetchone()[0]
            value['preview'] = latest[0].replace('\n', ' ') if latest else ''
            result.append(value)
        known = {row['id'] for row in result}
        for legacy in self.legacy_sessions():
            if legacy['id'] not in known and (root is None or legacy['root'] == str(Path(root).resolve())):
                result.append(legacy)
        return sorted(result, key=lambda row: row['updated'], reverse=True)

    def legacy_sessions(self):
        result = []
        for directory in (self.state / 'sessions').glob('*'):
            if not re.fullmatch('[0-9a-f]{32}', directory.name) or not (directory / 'history.sqlite3').is_file():
                continue
            binding = directory / '.nomo-workspace.json'
            value = json.loads(binding.read_text()) if binding.exists() else {}
            result.append({'id': directory.name, 'root': value.get('workspace', {}).get('path', ''),
                           'title': 'Earlier Nomo conversation', 'updated': value.get('used_ns', directory.stat().st_mtime_ns) / 1e9,
                           'preview': 'Select to load its saved conversation and work timeline.', 'messages': None, 'legacy': True})
        return result

    def import_legacy(self, identifier, root=None):
        row = next((item for item in self.legacy_sessions() if item['id'] == identifier), None)
        if row is None:
            raise ValueError('session not found: ' + identifier)
        root = row['root'] or root
        if not root:
            raise ValueError('this earlier session has no project binding; select --root when opening it')
        launcher = Path(__file__).resolve().parent / 'nomo'
        request = [sys.executable, str(launcher), '--legacy', '--id', identifier, '--status', '--events']
        result = subprocess.run(request, env=dict(os.environ, NOMO_STATE_DIR=str(self.state), NO_COLOR='1'),
                                stdin=subprocess.DEVNULL, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        parsed = []
        decoder = json.JSONDecoder()
        for line in result.stdout.splitlines():
            if 'TIMELINE ' not in line and 'UNORDERED ' not in line:
                continue
            if ' role=' not in line:
                continue
            fields, offset = {}, 0
            for field in ('role', 'kind', 'name', 'text'):
                start = line.index(field + '=', offset) + len(field) + 1
                fields[field], width = decoder.raw_decode(line[start:])
                offset = start + width
            parsed.append(fields)
        self.create(root, 'Earlier Nomo conversation', identifier=identifier)
        for event in parsed:
            role = event['role']
            if role == 'main':
                role = 'tool' if event['kind'] == 'tool' else 'assistant'
            if role == 'model' and event['kind'] == 'request':
                role = 'user'
            self.append(identifier, role, event['text'], kind='legacy', name=event['name'], data={'original_kind': event['kind']})

    def append(self, session, role, content, kind='message', name='', data=None):
        now = time.time()
        with self.connect() as db:
            cursor = db.execute('INSERT INTO projects_events(session,role,kind,name,content,data,created) VALUES(?,?,?,?,?,?,?)',
                                (session, role, kind, name, content, json.dumps(data or {}, ensure_ascii=False), now))
            db.execute('UPDATE projects_sessions SET updated=? WHERE id=?', (now, session))
            if role == 'user' and kind == 'message':
                db.execute("UPDATE projects_sessions SET title=? WHERE id=? AND title='New conversation'", (content.splitlines()[0][:80], session))
            return cursor.lastrowid

    def events(self, session, query=''):
        with self.connect() as db:
            rows = db.execute('SELECT * FROM projects_events WHERE session=? ORDER BY id', (session,)).fetchall()
        result = []
        for row in rows:
            event = dict(row)
            event['data'] = json.loads(event['data'])
            if not query or query.casefold() in event['content'].casefold():
                result.append(event)
        return result

    def context(self, session):
        current = self.session(session)
        with self.connect() as db:
            events = db.execute("SELECT id,role,name,content FROM projects_events WHERE session=? AND id>? AND kind!='compaction' AND NOT(kind='action' AND name='answer') ORDER BY id",
                                (session, current['compacted_through'])).fetchall()
        messages = [{'id': event['id'], 'role': event['role'], 'name': event['name'], 'content': event['content']}
                    for event in events]
        if current['summary']:
            messages.insert(0, {'id': current['compacted_through'], 'role': 'system', 'name': 'conversation_summary', 'content': current['summary']})
        return messages

    def requests(self, session):
        where = "session=? AND role='user' AND (kind='message' OR (kind='legacy' AND json_extract(data,'$.original_kind')='request'))"
        with self.connect() as db:
            first = db.execute('SELECT content FROM projects_events WHERE ' + where + ' ORDER BY id LIMIT 1', (session,)).fetchone()
            latest = db.execute('SELECT content FROM projects_events WHERE ' + where + ' ORDER BY id DESC LIMIT 1', (session,)).fetchone()
        return (first[0] if first else '', latest[0] if latest else '')

    def compact(self, session, through, summary):
        self.append(session, 'system', summary, kind='compaction', data={'through': through})
        with self.connect() as db:
            db.execute('UPDATE projects_sessions SET compacted_through=?,summary=? WHERE id=?', (through, summary, session))

    def usage(self, session, value):
        with self.connect() as db:
            db.execute('UPDATE projects_sessions SET usage=? WHERE id=?', (json.dumps(value), session))

    def rename(self, session, title):
        with self.connect() as db:
            db.execute('UPDATE projects_sessions SET title=? WHERE id=?', (title, session))

    def fork(self, session, through=None):
        source = self.session(session)
        target = self.create(source['root'], source['title'] + ' (branch)', parent=session)
        for event in self.events(session):
            if through is not None and event['id'] > through:
                break
            self.append(target, event['role'], event['content'], event['kind'], event['name'], event['data'])
        return target

    def export(self, session, destination):
        value = {'format': 'nomo-conversation-1', 'session': self.session(session), 'events': self.events(session)}
        path = Path(destination).expanduser()
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        path.chmod(0o600)
        return str(path.resolve())

    def import_file(self, source, root=None):
        value = json.loads(Path(source).expanduser().read_text())
        if value['format'] != 'nomo-conversation-1':
            raise ValueError('unsupported conversation format')
        target = self.create(root or value['session']['root'], value['session']['title'], parent=value['session']['id'])
        for event in value['events']:
            self.append(target, event['role'], event['content'], event['kind'], event['name'], event.get('data'))
        return target

    def delete(self, session):
        with self.connect() as db:
            db.execute('DELETE FROM projects_events WHERE session=?', (session,))
            db.execute('DELETE FROM projects_sessions WHERE id=?', (session,))

    def transcript(self, session, query=''):
        output = []
        for event in self.events(session, query):
            stamp = datetime.fromtimestamp(event['created']).strftime('%m-%d %H:%M:%S')
            output.append(f'[{event["id"]} · {stamp} · {event["role"]}' + (f'/{event["name"]}' if event['name'] else '') + ']\n' + event['content'])
        return '\n\n'.join(output)

    def choose(self, root=None, prompt=input):
        rows = self.sessions(root)
        for number, row in enumerate(rows, 1):
            stamp = datetime.fromtimestamp(row['updated']).strftime('%Y-%m-%d %H:%M')
            print(f'{number:>3}  {stamp}  {row["title"]}\n     {row["id"]}  {row["root"]}\n     {row["preview"]}')
        if not rows:
            print('No saved conversations.'); return None
        choice = prompt('Conversation number or ID (empty cancels): ').strip()
        return rows[int(choice) - 1]['id'] if choice.isdigit() else choice or None
