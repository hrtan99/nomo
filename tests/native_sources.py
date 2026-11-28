"""Copy the actual transitive Nomo imports used by a native fixture."""
import hashlib
from pathlib import Path
import re


def copy_sources(root: Path, package: Path, fixture: Path):
    entry = package / 'src/app/main.es'
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_bytes(fixture.read_bytes())
    pending = [fixture]
    sources = {str(fixture.relative_to(root)): hashlib.sha256(fixture.read_bytes()).hexdigest()}
    while pending:
        source = pending.pop()
        for imported in re.findall(r'(?m)^(?:public\s+)?import\s+(nomo[.A-Za-z0-9_]*)', source.read_text()):
            parts = imported.rstrip('.').split('.')
            while not (root / 'src' / '/'.join(parts)).with_suffix('.es').is_file():
                parts.pop()
            original = (root / 'src' / '/'.join(parts)).with_suffix('.es')
            relative = original.relative_to(root)
            if str(relative) in sources:
                continue
            target = package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(original.read_bytes())
            sources[str(relative)] = hashlib.sha256(original.read_bytes()).hexdigest()
            pending.append(original)
    return sources
