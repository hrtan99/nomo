"""Complete conversation archive; model context is a separate projection."""
from contextlib import contextmanager
from pathlib import Path
import json
import os
import secrets
import sqlite3
import time


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
            raise ValueError("fixture session not found: " + identifier)
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
        return sorted(result, key=lambda row: row['updated'], reverse=True)

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
