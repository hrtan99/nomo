"""Source-preserving agent and loop migration for the prepared Etas 0.22.4 graph."""

import re


PATTERN = re.compile(
    r'""".*?"""|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*.*?\*/|[A-Za-z_][A-Za-z_0-9]*|\S',
    re.S,
)


def tokens(text):
    return [m for m in PATTERN.finditer(text) if not m.group().startswith(("//", "/*"))]


def closing(items, start, left, right):
    depth = 0
    for index in range(start, len(items)):
        value = items[index].group()
        if value == left:
            depth += 1
        elif value == right:
            depth -= 1
            if depth == 0:
                return index
    raise ValueError("unclosed " + left)


def edits(text, replacements):
    for start, end, value in sorted(replacements, reverse=True):
        text = text[:start] + value + text[end:]
    return text


def method_body(text):
    strings = [(m.start(), m.end()) for m in tokens(text) if m.group().startswith(('"', "'"))]
    lines = text.splitlines(keepends=True)
    result = lines[0]
    position = len(lines[0])
    for line in lines[1:]:
        inside = any(start < position < end for start, end in strings)
        result += line if inside else "    " + line
        position += len(line)
    return result


def migrate(before):
    after = dict(before)
    agents = {}
    references = {}
    loop_limits = {}
    for name, text in before.items():
        if not name.startswith("src/") or not name.endswith(".es"):
            continue
        items = tokens(text)
        replacements = []
        for index, item in enumerate(items[:-2]):
            if item.group() != "agent" or items[index + 2].group() != "(":
                continue
            agent = items[index + 1].group()
            end_parameters = closing(items, index + 2, "(", ")")
            body_start = next(i for i in range(end_parameters + 1, len(items)) if items[i].group() == "{")
            body_end = closing(items, body_start, "{", "}")
            parameters = text[items[index + 2].end():items[end_parameters].start()]
            suffix = text[items[end_parameters].end():items[body_start].start()].replace("\n", "\n    ")
            body = method_body(text[items[body_start].start():items[body_end].end()])
            parameter_list = "self" + (", " + parameters if parameters.strip() else "")
            replacement = ("agent " + agent + " = {};\n\nimpl " + agent
                           + " {\n    public flow run(" + parameter_list + ")" + suffix + body + "\n}")
            replacements.append((item.start(), items[body_end].end(), replacement))
            agents.setdefault(name, []).append(agent)
        after[name] = edits(text, replacements)

    agent_names = {agent for names in agents.values() for agent in names}
    for name, text in after.items():
        if not name.startswith("src/") or not name.endswith(".es"):
            continue
        items = tokens(text)
        replacements = []
        for index in range(len(items) - 2):
            if (items[index].group() in agent_names and items[index + 1].group() == "."
                    and items[index + 2].group() == "run"):
                start = index
                while (start >= 2 and items[start - 1].group() == "."
                       and re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", items[start - 2].group())):
                    start -= 2
                qualified = text[items[start].start():items[index].end()]
                replacements.append((items[start].start(), items[index + 2].end(), "(" + qualified + " {}).run"))
                references.setdefault(name, []).append(qualified)
        after[name] = edits(text, replacements)

    for name, text in after.items():
        if not name.startswith("src/") or not name.endswith(".es"):
            continue
        items = tokens(text)
        replacements = []
        limits = []
        for index, item in enumerate(items):
            if item.group() not in ("for", "while"):
                continue
            parentheses = brackets = 0
            for cursor in range(index + 1, len(items) - 2):
                value = items[cursor].group()
                if (value == "limit" and parentheses == 0 and brackets == 0
                        and items[cursor + 1].group() == "Iterations" and items[cursor + 2].group() == "("):
                    end = closing(items, cursor + 2, "(", ")")
                    assert items[end + 1].group() == "{"
                    bound = text[items[cursor + 2].end():items[end].start()]
                    replacements.append((items[cursor].start(), items[end].end(), ""))
                    replacements.append((item.start(), item.start(), "@limits([Iterations(" + bound + ")]) "))
                    limits.append(bound)
                    break
                if value == "{" and parentheses == 0 and brackets == 0:
                    break
                parentheses += (value == "(") - (value == ")")
                brackets += (value == "[") - (value == "]")
        if limits:
            loop_limits[name] = limits
        after[name] = edits(text, replacements)

    # Concrete Host adapters in this composition already use the matching SDK.
    # Applying the old workspace/process free-function substitutions would now
    # target the identity-only leaves instead of the executable implementations.
    for name, text in before.items():
        if name.startswith("src/") and name.endswith(".es"):
            strings = lambda source: [m.group() for m in tokens(source) if m.group().startswith(('"', "'"))]
            assert strings(text) == strings(after[name]), (name, "migration changed a literal")
    return after, {
        "agent_declarations": sum(map(len, agents.values())),
        "instance_references": sum(map(len, references.values())),
        "bounded_loops": sum(map(len, loop_limits.values())),
        "agents": agents,
        "references": references,
        "loop_limit_expressions": loop_limits,
        "string_literals_preserved": True,
    }
