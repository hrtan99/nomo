"""Historical project registry and edit-path producer only."""
from pathlib import Path
import json
import os
import time

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)

class Workspace:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError('project must be a directory')

    def path(self, name):
        selected = (self.root / name).resolve()
        if not selected.is_relative_to(self.root):
            raise ValueError('path is outside the project')
        return selected

class ProjectRegistry:
    def __init__(self, state):
        self.path = Path(state) / 'projects.json'

    def recent(self):
        return json.loads(self.path.read_text()) if self.path.exists() else []

    def touch(self, root):
        root = str(Path(root).resolve())
        rows = [row for row in self.recent() if row['root'] != root]
        write_json(self.path, [{'root': root, 'name': Path(root).name, 'used': time.time()}, *rows])
