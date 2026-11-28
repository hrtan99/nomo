#!/usr/bin/env python3
"""Check Nomo module ownership, import resolution and layer dependencies."""
import json
from pathlib import Path
import re
import sys

from lib.etas_source import tokens

ROOT = Path(__file__).resolve().parents[1]
DECLARATIONS = {'type', 'alias', 'enum', 'let', 'flow', 'tool', 'agent', 'spec', 'effect'}


def declarations(source):
    items = tokens(source)
    result = {}
    depth = 0
    for index, item in enumerate(items[:-1]):
        word = item.group()
        if (depth == 0 and word in DECLARATIONS and
                (index == 0 or items[index - 1].group() != '.') and
                re.fullmatch(r'[A-Za-z_]\w*', items[index + 1].group())):
            name = items[index + 1].group()
            public = index > 0 and items[index - 1].group() == 'public'
            result[name] = {'kind': word, 'public': public, 'index': index}
        depth += (word == '{') - (word == '}')
    return items, result


def imports(source):
    for match in re.finditer(r'(?m)^(public )?import ([\w.]+)(?:\.\{([^}]+)\})?(?: as (\w+))?;', source):
        public, path, group, alias = match.groups()
        if group is None:
            yield path, alias or path.rsplit('.', 1)[-1], bool(public)
        else:
            for entry in group.split(','):
                names = entry.strip().split(' as ')
                yield path + '.' + names[0], names[-1], bool(public)


def main():
    policy = json.loads((ROOT / 'config/architecture.json').read_text())
    modules = {}
    errors = []
    for path in sorted((ROOT / 'src').rglob('*.es')):
        source = path.read_text()
        module = re.search(r'^module ([\w.]+);', source).group(1)
        expected = ROOT / ('src/' + module.replace('.', '/') + '.es')
        if path != expected:
            errors.append(f'{path.relative_to(ROOT)}: module/path mismatch: {module}')
        if module in modules:
            errors.append(f'{path.relative_to(ROOT)}: duplicate module {module}')
        items, definitions = declarations(source)
        modules[module] = (path, source, items, definitions)
    exports = {name: {symbol for symbol, definition in values[3].items() if definition['public']}
               for name, values in modules.items()}
    for _ in modules:
        changed = False
        for name, (_, source, _, _) in modules.items():
            for target, local, public in imports(source):
                if not public or target.startswith('std.'):
                    continue
                owner, symbol = target.rsplit('.', 1)
                if owner in exports and symbol in exports[owner] and local not in exports[name]:
                    exports[name].add(local)
                    changed = True
        if not changed:
            break
    edges = 0
    graph = {name: set() for name in modules}
    for name, (path, source, items, definitions) in modules.items():
        layer = name.split('.')[1]
        if layer == 'bootstrap':
            allowed = policy.get('assembly_bindings', {}).get(name, [])
            for match in re.finditer(r'(?m)^impl\s+([^;{\n]+)', source):
                binding = ' '.join(match[1].split())
                if binding not in allowed:
                    errors.append(f'{path.relative_to(ROOT)}: concrete impl belongs in adapters: {binding}')
        if layer == 'domain' and (any(definition['kind'] in ('agent', 'tool', 'effect') for definition in definitions.values()) or
                                  any(item.group() == 'perform' for item in items)):
            errors.append(f'{path.relative_to(ROOT)}: domain must contain passive data and pure rules')
        if layer not in policy['layers'] and name not in policy['root_modules']:
            errors.append(f'{path.relative_to(ROOT)}: source must belong to an architecture layer')
        if layer == 'domain' and any(item.group() == 'MemoryRegion' for item in items):
            errors.append(f'{path.relative_to(ROOT)}: concrete storage schema belongs in adapters')
        for target, _, _ in imports(source):
            if not target.startswith('nomo.'):
                continue
            edges += 1
            owner, symbol = target.rsplit('.', 1)
            if target in modules:
                owner, symbol = target, None
            elif owner not in modules or symbol not in exports[owner]:
                errors.append(f'{path.relative_to(ROOT)}: unresolved public import {target}')
                continue
            graph[name].add(owner)
            forbidden = ('nomo.application.', 'nomo.adapters.', 'nomo.bootstrap.') if layer == 'domain' else ('nomo.adapters.', 'nomo.bootstrap.') if layer == 'application' else ()
            if owner.startswith(forbidden):
                errors.append(f'{path.relative_to(ROOT)}: {layer} must not import {owner}')
    colors = {}
    stack = []
    def visit(name):
        colors[name] = 1
        stack.append(name)
        for target in sorted(graph[name]):
            if colors.get(target) == 1:
                cycle = stack[stack.index(target):] + [target]
                errors.append('import cycle: ' + ' -> '.join(cycle))
            elif target not in colors:
                visit(target)
        stack.pop()
        colors[name] = 2
    for name in sorted(modules):
        if name not in colors:
            visit(name)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'PASS architecture: {len(modules)} modules, {edges} imports; all modules belong to current layers')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
