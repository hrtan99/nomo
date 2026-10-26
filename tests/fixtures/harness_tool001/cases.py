"""Deterministic protocol replies and independent tool-child route observations."""
import json
from pathlib import Path

TOKEN = "NOMO_HARNESS_TOOL_LOOPBACK_NOT_A_SECRET"
WRAPPER = "Nomo model/tool harness refused; see REFUSED output"
WORKSPACE = Path(__file__).resolve().parent / "workspace"
HELP = (
    "Nomo model/tool harness: new --once TEXT --allow FILE[,FILE] (either flag order).\n"
    "Raw request/task 1..128, child 1..256, final 1..512 printable ASCII; 1..2 paths of <=48 characters, raw allowlist <=97.\n"
    "Shared maximum: 7 steps / 4 model calls / 8192 token allowance / 1 read-or-search / 4096 scan allowance; not measured usage.\n"
    "Complete model context <=2048. Read size checked after reading. One fresh serial child; no writes, commands, resume, line mode or persistence. Host aborts may leave reservations unresolved.\n"
)


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def display(text):
    return "".join({"<": "<LT>", "\n": "<LF>", "\r": "<CR>", "\t": "<TAB>"}.get(c, c) for c in text)


def base(label, **changes):
    value = {"label": "tool-" + label, "kind": "success", "request": "Find the value", "task": "Inspect the allowed file",
             "allowed": ["docs/a.txt"], "variant": "alpha", "action": ["read", "docs/a.txt"],
             "calls": 4, "reads": 1, "profile_mode": "normal", "ledger": [7, 4, 8192, 1, 4096]}
    value.update(changes)
    value.setdefault("args", ["new", "--once", value["request"], "--allow", ",".join(value["allowed"])])
    return value


def direct(label, **changes):
    defaults = {"action": ["final", "DIRECT"], "calls": 3, "reads": 0, "ledger": [5, 3, 6144, 0, 0]}
    defaults.update(changes)
    return base(label, **defaults)


def cases():
    values = [base("bytes-alpha"), base("bytes-beta", variant="beta"), direct("direct-final"),
              base("search-one", action=["search", "NEEDLE", "docs/a.txt"]),
              base("search-two", action=["search", "NEEDLE", "docs/a.txt", "docs/b.txt"],
                   allowed=["docs/a.txt", "docs/b.txt"], reads=2),
              base("search-literal-not-regex", variant="literal", allowed=["literal.txt"], action=["search", "a.*b", "literal.txt"]),
              base("search-no-match", action=["search", "ABSENT", "docs/a.txt"]),
              base("read-empty", variant="empty", allowed=["empty.txt"], action=["read", "empty.txt"]),
              base("read-marker-encoding", variant="markers", allowed=["markers.txt"], action=["read", "markers.txt"]),
              base("read-display256", variant="bounds", allowed=["result256.txt"], action=["read", "result256.txt"], child_text="BOUNDARY"),
              base("request-task128-escaping", request='"\\' * 64, task='"\\' * 64, child_text="ESCAPED"),
              base("raw-request-task-spaces", request="  raw request  ", task="  raw task  "),
              direct("child256-parent512", child_text="x" * 256, final_text="y" * 512),
              direct("child-action-looking-data", child_text=encoded(["read", "missing.txt"])),
              direct("literal-allow-value", request="--allow"),
              direct("allow-before-once", args=["new", "--allow", "docs/a.txt", "--once", "Find the value"])]
    plan = encoded(["delegate", "bounded"])
    raw384 = plan[:-1] + " " * (384 - len(plan)) + "]"
    values.append(direct("plan-raw384", task="bounded", plan_raw=raw384))
    for label, raw, diagnostic in [
        ("raw385", raw384[:-1] + " ]", "expected bounded flat single-line delegation JSON"),
        ("nested", '["delegate",["x"]]', "expected bounded flat single-line delegation JSON"),
        ("wrong-type", '["delegate",3]', "expected bounded flat single-line delegation JSON"),
        ("trailing", '["delegate","x"] trailing', "expected bounded flat single-line delegation JSON"),
        ("bad-json", '["delegate",,"x"]', "invalid delegation JSON"),
        ("unsupported", '["read","x"]', "unsupported delegation verb or arity"),
        ("task129", encoded(["delegate", "x" * 129]), "invalid bounded delegated task"),
        ("task-empty", '["delegate",""]', "invalid bounded delegated task"),
        ("task-control", encoded(["delegate", "a\nb"]), "invalid bounded delegated task"),
    ]:
        values.append(base("plan-" + label, kind="plan_refusal", plan_raw=raw, diagnostic=diagnostic,
                           calls=1, reads=0, ledger=[1, 1, 2048, 0, 0]))
    for label, action, diagnostic in [
        ("unsupported", ["write", "docs/a.txt"], "unsupported action or arity"),
        ("unallowed", ["read", "docs/b.txt"], "selected file is not allowed"),
        ("invalid-path", ["read", "../outside.txt"], "invalid allowed file"),
        ("duplicate-search", ["search", "x", "docs/a.txt", "docs/a.txt"], "duplicate allowed file"),
        ("final-empty", ["final", ""], "invalid bounded final answer"),
        ("final-spaces", ["final", "  "], "invalid bounded final answer"),
        ("final-control", ["final", "a\nb"], "invalid bounded final answer"),
    ]:
        values.append(base("action-" + label, kind="child_refusal", action=action, child_error=diagnostic,
                           calls=2, reads=0, ledger=[3, 2, 4096, 0, 0]))
    values.append(base("action-malformed", kind="child_refusal", action_raw='["read",',
                       child_error="expected bounded flat single-line JSON string array", calls=2, reads=0, ledger=[3, 2, 4096, 0, 0]))
    values.append(base("second-tool-refused", kind="child_refusal", second_raw=encoded(["read", "docs/a.txt"]),
                       child_error="second response must be final", calls=3, ledger=[5, 3, 6144, 1, 4096]))
    values.append(base("read-display257", kind="tool_refusal", variant="bounds", allowed=["result257.txt"],
                       action=["read", "result257.txt"], tool_error="refused: tool result exceeds 256 display characters",
                       calls=2, ledger=[4, 2, 4096, 1, 4096]))
    action = encoded(["read", "docs/a.txt"])
    raw_action384 = action[:-1] + " " * (384 - len(action)) + "]"
    values.append(base("action-raw384", action_raw=raw_action384))
    values.append(base("action-raw385", kind="child_refusal", action_raw=raw_action384[:-1] + " ]",
                       child_error="tool action exceeds 384 raw characters", calls=2, reads=0, ledger=[3, 2, 4096, 0, 0]))
    for size in [257, 512]:
        values.append(direct("child" + str(size) + "-parent-refusal", kind="result_refusal", child_text="x" * size,
                             calls=2, ledger=[3, 2, 4096, 0, 0]))
    values.append(base("tool-child257-parent-refusal", kind="result_refusal", child_text="x" * 257,
                       calls=3, ledger=[5, 3, 6144, 1, 4096]))
    values.append(direct("allow97-two-paths", allowed=["a" * 48, "b" * 48]))
    for label, answer in [("513", "x" * 513), ("unicode", "世界"), ("spaces", "  ")]:
        values.append(direct("parent-" + label, kind="final_refusal", final_text=answer))
    entry = [
        ("no-args", [], "expected bounded new --once TEXT --allow FILE[,FILE]"),
        ("no-once", ["new", "--allow", "docs/a.txt"], "this entry requires new --once TEXT"),
        ("no-allow", ["new", "--once", "Q"], "this entry requires --allow FILE[,FILE]"),
        ("resume", ["resume", "--id", "owned", "--allow", "docs/a.txt"], "resume is unavailable in the model/tool harness"),
        ("request129", ["new", "--once", "x" * 129, "--allow", "docs/a.txt"], "question requires 1..128 printable ASCII chars, not only spaces"),
        ("request-control", ["new", "--once", "a\nb", "--allow", "docs/a.txt"], "expected printable ASCII single-line input"),
        ("duplicate-allow", ["new", "--once", "Q", "--allow", "docs/a.txt", "--allow", "docs/a.txt"], "expected exactly one --allow FILE[,FILE]"),
        ("invalid-allow", ["new", "--once", "Q", "--allow", "../outside.txt"], "invalid allowed file"),
        ("duplicate-path", ["new", "--once", "Q", "--allow", "docs/a.txt,docs/a.txt"], "duplicate allowed file"),
        ("allow98", ["new", "--once", "Q", "--allow", "a" * 48 + "," + "b" * 49], "raw allowlist exceeds 97 characters"),
        ("help-combined", ["help", "--allow", "docs/a.txt"], "help must be used alone"),
    ]
    for label, args, diagnostic in entry:
        values.append(base("entry-" + label, kind="entry_refusal", args=args, diagnostic=diagnostic,
                           calls=0, reads=0, ledger=[0, 0, 0, 0, 0]))
    values.append(base("help", kind="help", args=["help"], calls=0, reads=0))
    for phase, calls, reads in [("plan", 1, 0), ("child-first", 2, 0), ("child-final", 3, 1), ("aggregate", 4, 1)]:
        values.append(base("host-" + phase + "-503", kind="host_abort", fail_phase=phase, fail_mode="unavailable", calls=calls, reads=reads))
    for label, phase, mode, calls, reads in [("malformed", "child-first", "malformed", 2, 0),
                                             ("usage", "child-first", "missing_usage", 2, 0),
                                             ("tokens", "child-final", "token_overrun", 3, 1),
                                             ("deadline", "aggregate", "timeout", 4, 1),
                                             ("empty-content", "child-first", "empty", 2, 0)]:
        values.append(base("host-" + label, kind="host_abort", fail_phase=phase, fail_mode=mode, calls=calls, reads=reads))
    for mode, calls, reads in [("missing-model", 0, 0), ("missing-file", 0, 0),
                               ("denied-model", 0, 0), ("denied-file", 2, 0), ("connection", 0, 0)]:
        values.append(base("host-" + mode, kind="host_abort", profile_mode=mode, calls=calls, reads=reads))
    values.append(base("host-read-missing", kind="host_abort", action=["read", "missing.txt"],
                       allowed=["missing.txt"], calls=2, reads=1, file_failed=True))
    values.append(base("host-search-second-missing", kind="host_abort", action=["search", "NEEDLE", "docs/a.txt", "missing.txt"],
                       allowed=["docs/a.txt", "missing.txt"], calls=2, reads=2, file_failed=True))
    labels = [item["label"] for item in values]
    assert len(values) == len(set(labels)) and len(values) <= 96
    return values


def expected_outcome(item):
    action = item["action"]
    if action[0] == "final":
        return "", ""
    if item.get("tool_error"):
        return action[0], item["tool_error"]
    if action[0] == "read":
        text = (WORKSPACE / item["variant"] / action[1]).read_text()
    else:
        text = "".join(name + ":" + str(index) + "\n" for name in action[2:]
                       for index, line in enumerate((WORKSPACE / item["variant"] / name).read_text().split("\n"), 1)
                       if action[1] in line)
    return action[0], "complete: " + display(text)


def child_answer(item, outcome):
    return item.get("child_text", item["action"][1] if item["action"][0] == "final" else "Seen: " + outcome)


def parent_answer(item, result, tool, outcome):
    return item.get("final_text", "Answer: " + result + "|" + tool + "|" + outcome)


def numbers(values):
    return " ".join(name + "=" + str(value) for name, value in zip(["steps", "calls", "tokens", "tools", "scan"], values))


def stage(phase, state):
    reserved = [6, 3, 6144, 1, 4096] if phase == "plan" else [5, 3, 6144, 1, 4096] if phase == "child" else [0] * 5
    line = "STAGE " + phase + " child-1 " + numbers(state)
    line += " " + " ".join("reserved_" + name + "=" + str(value)
                             for name, value in zip(["steps", "calls", "tokens", "tools", "scan"], reserved)) + "\n"
    if phase == "child":
        line += "RESERVATION child-1 steps=3 calls=2 tokens=4096 tools=1 scan=4096 tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true\n"
    return line


def settled(state):
    return ("SETTLED child-1 " + numbers(state) + " "
            + " ".join("released_" + name + "=" + str(limit - value)
                       for name, value, limit in zip(["steps", "calls", "tokens", "tools", "scan"], state, [5, 3, 6144, 1, 4096]))
            + " unresolved=false\n")


def ledger(state):
    return ("LEDGER " + " ".join(name + "=" + str(value) + "/" + str(limit)
                                  for name, value, limit in zip(["steps", "calls", "tokens", "tools", "scan"], state, [7, 4, 8192, 1, 4096]))
            + " reserved_steps=0 reserved_calls=0 reserved_tokens=0 reserved_tools=0 reserved_scan=0\n")


def expected_stdout(item):
    kind, mode = item["kind"], item["profile_mode"]
    if kind == "help":
        return HELP
    if kind == "entry_refusal":
        return "REFUSED " + item["diagnostic"] + "\n" + ledger(item["ledger"])
    if mode in {"missing-model", "missing-file"}:
        return ""
    text = stage("plan", [1, 1, 2048, 0, 0])
    if kind == "plan_refusal":
        return text + "REFUSED " + item["diagnostic"] + "\n" + ledger(item["ledger"])
    if kind == "host_abort" and (item.get("fail_phase") == "plan" or mode in {"denied-model", "connection"}):
        return text
    text += "EVENT main -> child-1 request child-1: " + item["task"] + "\n" + stage("child", [2, 1, 2048, 0, 0])
    text += "user: " + item["task"] + "\nmodel: text qwen\n"
    if kind == "host_abort" and item.get("fail_phase") == "child-first":
        return text
    second = item.get("second_raw") is not None
    if kind == "child_refusal" and not second:
        text += "error: " + item["child_error"] + "\n"
    else:
        if item["action"][0] != "final":
            tool = item["action"][0]
            text += "model: tool " + tool + "\n"
            if kind == "host_abort" and (item.get("file_failed") or mode == "denied-file"):
                return text
            tool, outcome = expected_outcome(item)
            text += ("error: " if kind == "tool_refusal" else "tool: " + tool + ": ") + outcome + "\n"
            if kind != "tool_refusal":
                text += "model: text qwen\n"
                if kind == "host_abort" and item.get("fail_phase") == "child-final":
                    return text
        else:
            tool, outcome = "", ""
        if second:
            text += "error: " + item["child_error"] + "\n"
        elif kind != "tool_refusal":
            text += "assistant: " + child_answer(item, outcome) + "\n"
    state = item["ledger"][:]
    if kind in {"success", "final_refusal"} or kind == "host_abort":
        state[0] -= 2
        state[1] -= 1
        state[2] -= 2048
    text += settled(state)
    if kind in {"child_refusal", "tool_refusal", "result_refusal"}:
        diagnostic = "invalid bounded child result" if kind == "result_refusal" else "child returned failure; no aggregation"
        return text + "REFUSED " + diagnostic + "\n" + ledger(state)
    result = child_answer(item, outcome)
    text += "EVENT child-1 -> main result child-1: " + result + "\nEVENT main -> main consume child-1: " + result + "\n"
    if tool:
        text += "EVENT main -> main tool " + tool + ": " + outcome + "\n"
    text += stage("aggregate", item["ledger"])
    if kind == "host_abort":
        return text
    if kind == "final_refusal":
        return text + "REFUSED invalid bounded final answer\n" + ledger(item["ledger"])
    return text + "FINAL " + parent_answer(item, result, tool, outcome) + "\n" + ledger(item["ledger"])
