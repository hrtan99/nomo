"""Object adapters implementing the project tool catalogue declared in Etas."""
from pathlib import Path
import base64
import copy
import json
import os
import secrets
import shutil
from nomo_project import write_json


def snapshot(path):
    if not path.exists():
        return None
    if path.is_dir():
        return {'directory': {item.name: snapshot(item) for item in path.iterdir()}}
    return {'bytes': base64.b64encode(path.read_bytes()).decode(), 'mode': path.stat().st_mode & 0o777}


def restore(path, value):
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()
    if value is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if 'directory' in value:
        path.mkdir()
        for name, child in value['directory'].items():
            restore(path / name, child)
    else:
        temporary = path.with_name('.' + path.name + '.nomo-' + secrets.token_hex(4))
        temporary.write_bytes(base64.b64decode(value['bytes']))
        temporary.chmod(value.get('mode', 0o644))
        temporary.replace(path)


def text_node(text, previous=None):
    return {'bytes': base64.b64encode(text.encode()).decode(), 'mode': (previous or {}).get('mode', 0o644)}


def node_text(value):
    return base64.b64decode(value['bytes']).decode('utf-8', 'replace') if value and 'bytes' in value else ''


class BatchEditor:
    def __init__(self, workspace, state, session):
        self.workspace, self.session = workspace, session
        self.directory = Path(state) / 'edits'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def prepare(self, changes):
        steps, virtual = [], {}
        def observed(name):
            if name in virtual:
                return copy.deepcopy(virtual[name])
            candidate = Path(name)
            for ancestor in candidate.parents:
                key = ancestor.as_posix()
                if key in virtual:
                    node = virtual[key]
                    for part in candidate.relative_to(ancestor).parts:
                        node = (node or {}).get('directory', {}).get(part)
                    return copy.deepcopy(node)
            return snapshot(self.workspace.path(name))

        def stage(name, before, after):
            steps.append({'path': name, 'before': copy.deepcopy(before), 'after': copy.deepcopy(after)})
            for descendant in list(virtual):
                if descendant != name and Path(descendant).is_relative_to(Path(name)):
                    del virtual[descendant]
            virtual[name] = copy.deepcopy(after)
            for ancestor in Path(name).parents:
                key = ancestor.as_posix()
                if key not in virtual or virtual[key] is None:
                    continue
                node = virtual[key]
                parts = Path(name).relative_to(ancestor).parts
                for part in parts[:-1]:
                    node = node['directory'][part]
                if after is None:
                    node['directory'].pop(parts[-1], None)
                else:
                    node['directory'][parts[-1]] = copy.deepcopy(after)

        def parents(name):
            for parent in reversed(Path(name).parents):
                if parent.as_posix() != '.' and observed(parent.as_posix()) is None:
                    stage(parent.as_posix(), None, {'directory': {}})

        for change in changes:
            name, operation = change['path'], change['operation']
            path = self.workspace.path(name)
            if path == self.workspace.root:
                raise ValueError('file operations require a path below the project root')
            name = path.relative_to(self.workspace.root).as_posix()
            parents(name)
            before = observed(name)
            if operation in ('write', 'create'):
                if operation == 'create' and before is not None:
                    raise ValueError('file already exists: ' + name)
                after = text_node(change.get('text', ''), before)
            elif operation == 'edit':
                original, target = node_text(before), change['target']
                if before is None or original.count(target) != 1:
                    raise ValueError('edit target must occur exactly once: ' + name)
                after = text_node(original.replace(target, change['text'], 1), before)
            elif operation == 'mkdir':
                after = before if before is not None else {'directory': {}}
            elif operation in ('delete', 'move'):
                if before is None:
                    raise ValueError('path does not exist: ' + name)
                after = None
            else:
                raise ValueError('unknown file operation: ' + operation)
            stage(name, before, after)
            if operation == 'move':
                destination = self.workspace.path(change['target']).relative_to(self.workspace.root).as_posix()
                parents(destination)
                previous = observed(destination)
                if previous is not None:
                    raise ValueError('move destination already exists: ' + destination)
                stage(destination, previous, before)
        return steps

    def apply(self, steps):
        identifier = secrets.token_hex(8)
        record = {'id': identifier, 'root': str(self.workspace.root), 'session': self.session, 'phase': 'applying', 'steps': steps}
        journal = self.directory / (identifier + '.json')
        write_json(journal, record)
        completed = []
        try:
            for step in steps:
                path = self.workspace.path(step['path'])
                if snapshot(path) != step['before']:
                    raise ValueError('file changed since preview: ' + step['path'])
                completed.append(step)
                restore(path, step['after'])
        except Exception:
            for step in reversed(completed):
                restore(self.workspace.path(step['path']), step['before'])
            record['phase'] = 'rolled_back'; write_json(journal, record)
            raise
        record['phase'] = 'applied'; write_json(journal, record)
        return {'edit': identifier, 'paths': [step['path'] for step in steps], 'status': 'applied'}
