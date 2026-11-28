"""Shared Etas tokenization for architecture checks; no source rewriting."""
import re

PATTERN = re.compile(
    r'""".*?"""|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*.*?\*/|[A-Za-z_][A-Za-z_0-9]*|\S',
    re.S,
)


def tokens(text):
    return [m for m in PATTERN.finditer(text) if not m.group().startswith(("//", "/*"))]
