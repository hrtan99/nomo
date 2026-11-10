"""Project configuration and navigation adapters for the Etas project agent."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
import fnmatch
import json
import os
import re
import time
import tomllib


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


@dataclass
class ProjectConfig:
    context_window: int = 1_000_000
    max_output_tokens: int = 131072
    compact_ratio: float = 0.75
    keep_messages: int = 12
    command_timeout: int = 600
    ignore: list = field(default_factory=list)
    instructions: list = field(default_factory=list)
    check: list = field(default_factory=list)

    @classmethod
    def load(cls, root):
        path = Path(root) / '.nomo.toml'
        values = tomllib.loads(path.read_text()) if path.exists() else {}
        values = values.get('project', values)
        result = cls(**{key: value for key, value in values.items() if key in cls.__dataclass_fields__})
        if not 1 <= result.max_output_tokens <= 131072 or result.context_window <= result.max_output_tokens:
            raise ValueError('context_window must exceed max_output_tokens (1..131072)')
        return result


class ProjectNavigator(Protocol):
    def tree(self, path='.', depth=3): ...
    def glob(self, pattern='**/*'): ...
    def read(self, path, start=1, end=0): ...
    def search(self, pattern, path='.', regex=False): ...


class IgnoreRules:
    """Nested .gitignore rules, including anchored paths and negation."""
    def __init__(self, root, extra=()):
        self.root, self.extra, self.cache = Path(root), list(extra), {}

    def rules(self, directory):
        if directory not in self.cache:
            source = self.root / directory / '.gitignore'
            self.cache[directory] = source.read_text().splitlines() if source.is_file() else []
        return self.cache[directory]

    @staticmethod
    def expression(pattern):
        expression = ''
        index = 0
        while index < len(pattern):
            character = pattern[index]
            if pattern[index:index + 3] == '**/':
                expression += '(?:.*/)?'; index += 3; continue
            if pattern[index:index + 2] == '**':
                expression += '.*'; index += 2; continue
            if character == '[':
                closing = pattern.find(']', index + 1)
                if closing > index + 1:
                    expression += fnmatch.translate(pattern[index:closing + 1])[4:-3]
                    index = closing + 1; continue
            if character == '\\' and index + 1 < len(pattern):
                expression += re.escape(pattern[index + 1]); index += 2; continue
            expression += '[^/]*' if character == '*' else '[^/]' if character == '?' else re.escape(character)
            index += 1
        return expression

    @staticmethod
    def match(relative, pattern, directory):
        directory_only = pattern.endswith('/')
        pattern = pattern.rstrip('/')
        anchored = pattern.startswith('/')
        pattern = pattern.lstrip('/')
        parts = relative.split('/')
        candidates = ['/'.join(parts[:i]) for i in range(1, len(parts) + 1)]
        if directory_only and not directory:
            candidates = candidates[:-1]
        expression = IgnoreRules.expression(pattern)
        if '/' not in pattern and not anchored:
            return any(re.fullmatch(expression, part) for candidate in candidates for part in candidate.split('/'))
        return any(re.fullmatch(expression, candidate) for candidate in candidates)

    def ignored(self, path, directory=False):
        relative = path.as_posix()
        if any(part in ('.git', '.nomo') for part in path.parts):
            return True
        ignored = False
        for index in range(len(path.parts)):
            base = Path(*path.parts[:index])
            local = '/'.join(path.parts[index:])
            for raw in self.rules(base):
                pattern = raw.rstrip()
                if not pattern or pattern.startswith('#'):
                    continue
                negate = pattern.startswith('!')
                pattern = pattern[1:] if negate else pattern
                if pattern.startswith(('\\#', '\\!')):
                    pattern = pattern[1:]
                if self.match(local, pattern, directory):
                    ignored = not negate
        for pattern in self.extra:
            if self.match(relative, pattern, directory):
                ignored = True
        return ignored


class Workspace:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError('project must be a directory')
        self.config = ProjectConfig.load(self.root)

    def path(self, name):
        selected = (self.root / name).resolve()
        if not selected.is_relative_to(self.root):
            raise ValueError('path is outside the project')
        return selected

    def files(self, path='.'):
        start = self.path(path)
        ignore = IgnoreRules(self.root, self.config.ignore)
        if start.is_file():
            yield start.relative_to(self.root)
            return
        for directory, dirs, names in os.walk(start):
            base = Path(directory).relative_to(self.root)
            dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink()
                             and not ignore.ignored(base / name, True))
            for name in sorted(names):
                relative = base / name
                if not ignore.ignored(relative) and not (self.root / relative).is_symlink():
                    yield relative

    def tree(self, path='.', depth=3):
        start = self.path(path)
        ignore = IgnoreRules(self.root, self.config.ignore)
        entries = []
        for directory, dirs, files in os.walk(start):
            base = Path(directory)
            level = len(base.relative_to(start).parts)
            dirs[:] = sorted(name for name in dirs if not (base / name).is_symlink()
                             and not ignore.ignored((base / name).relative_to(self.root), True))
            for name in dirs + sorted(files):
                item = base / name
                relative = item.relative_to(self.root)
                if not ignore.ignored(relative, item.is_dir()):
                    entries.append('  ' * level + name + ('/' if item.is_dir() else ''))
            if depth and level + 1 >= depth:
                dirs.clear()
        return '\n'.join(entries)

    def glob(self, pattern='**/*'):
        return '\n'.join(path.as_posix() for path in self.files()
                         if re.fullmatch(IgnoreRules.expression(pattern), path.as_posix()))

    def read(self, path, start=1, end=0):
        with self.path(path).open(encoding='utf-8', newline='') as stream:
            text = stream.read()
        lines = text.splitlines(keepends=True)
        first = max(1, start)
        last = end or len(lines)
        return ''.join(f'{number}: {line}' for number, line in enumerate(lines, 1) if first <= number <= last)

    def search(self, pattern, path='.', regex=False):
        expression = re.compile(pattern if regex else re.escape(pattern))
        hits = []
        for relative in self.files(path):
            try:
                lines = (self.root / relative).read_text().splitlines()
            except (UnicodeError, OSError):
                continue
            hits.extend(f'{relative}:{number}:{line}' for number, line in enumerate(lines, 1) if expression.search(line))
        return '\n'.join(hits)

    def instructions(self):
        instructions = []
        # Root rules are available immediately. Scoped rules are included with
        # their directory so the model applies them only to that subtree.
        for path in self.files():
            if path.name == 'AGENTS.md':
                instructions.append({'scope': path.parent.as_posix(), 'text': (self.root / path).read_text()})
        instructions += [{'scope': '.', 'text': text} for text in self.config.instructions]
        if self.config.check:
            instructions.append({'scope': '.', 'text': 'Project verification command argv: ' + json.dumps(self.config.check)})
        return instructions


class ProjectRegistry:
    def __init__(self, state):
        self.path = Path(state) / 'projects.json'

    def recent(self):
        return json.loads(self.path.read_text()) if self.path.exists() else []

    def touch(self, root):
        root = str(Path(root).resolve())
        rows = [row for row in self.recent() if row['root'] != root]
        write_json(self.path, [{'root': root, 'name': Path(root).name, 'used': time.time()}, *rows])

    def choose(self, prompt=input):
        rows = self.recent()
        for number, row in enumerate(rows, 1):
            print(f'{number:>3}  {row["name"]}  {row["root"]}')
        choice = prompt('Project number or folder path: ').strip()
        return rows[int(choice) - 1]['root'] if choice.isdigit() else str(Path(choice).expanduser().resolve())
