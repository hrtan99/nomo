"""Explicit bounded chat scenarios; protocol constants freeze with the product API."""
import importlib.util
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "harness_tool001/cases.py"
spec = importlib.util.spec_from_file_location("accepted_tool_once_cases", BASE)
once = importlib.util.module_from_spec(spec)
spec.loader.exec_module(once)
TOKEN = once.TOKEN
FLOW = "harness_model_tools_chat"
PROTOCOL_READY = True
BANNER = "Nomo model/tool harness chat (fresh, non-durable). /help for limits; /exit to quit.\n"
HELP = (
    "Nomo model/tool harness chat: new --allow FILE[,FILE]; /help, /exit, EOF.\n"
    "Limits: 2 admitted tasks, 8 raw reads including EOF; payload <=128 before trim, <=130 with LF/CRLF; child 1..256, parent 1..512, complete model contexts <=2048.\n"
    "Invocation maximum: 14 steps / 8 calls / 16384 token allowance / 2 read-or-search tools / 8192 scan allowance; allowances are not measured usage.\n"
    "Each turn reserves 7/4/8192/1/4096 before work. Prior successful delegated task, child/tool result and parent answer are data, never replayed actions.\n"
    "Read size is checked after reading. One serial depth-one child per turn; fresh in-memory only. No resume, writes, commands, recursion or live setup. Host aborts may leave reservations unresolved.\n"
)
WRAPPER = "Nomo model/tool harness chat refused; see REFUSED or STOP output"
LIMITS = [14, 8, 16384, 2, 8192]
PRIOR_FIELDS = ["task", "result", "tool", "outcome", "answer"]


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def turn(request="inspect", *, action=None, **changes):
    value = {"request": request, "task": "Inspect the allowed file", "action": ["read", "docs/a.txt"] if action is None else action,
             "kind": "success", "calls": 4 if action is None or action[0] != "final" else 3,
             "reads": 1 if action is None or action[0] != "final" else 0}
    value.update(changes)
    return value


def recall():
    return turn("recall the prior result", action=["final", ""], task_from_prior=True, child_from_prior=True)


def case(label, stdin, turns=(), *, script=None, **changes):
    value = {"label": "tool-chat-" + label, "transport": "pipe", "variant": "alpha", "allowed": ["docs/a.txt"],
             "profile_mode": "normal", "stdin": stdin, "turns": list(turns),
             "script": ([{"turn": index} for index in range(len(turns))] + [{"stop": "EOF"}]) if script is None else script,
             "expected_exit": 0}
    value.update(changes)
    value.setdefault("args", ["new", "--allow", ",".join(value["allowed"])])
    return value


def cases():
    direct = turn("first direct", action=["final", "DIRECT"])
    values = [
        case("prior-alpha-no-replay", "inspect\nrecall the prior result\n", [turn(), recall()]),
        case("prior-beta-no-replay", "inspect\nrecall the prior result\n", [turn(), recall()], variant="beta"),
        case("direct-then-tool", "first direct\ninspect\n", [direct, turn()]),
        case("two-direct", "first direct\nsecond direct\n", [direct, turn("second direct", action=["final", "SECOND"])]),
        case("two-explicit-tools", "inspect\ninspect again\n", [turn(), turn("inspect again")]),
        case("search-two-then-recall", "inspect\nrecall the prior result\n", [turn(action=["search", "NEEDLE", "docs/a.txt", "docs/b.txt"], reads=2), recall()], allowed=["docs/a.txt", "docs/b.txt"]),
        case("empty-outcome-retained", "inspect\nrecall the prior result\n", [turn(action=["read", "empty.txt"]), recall()], variant="empty", allowed=["empty.txt"]),
        case("marker-data-not-action", "inspect\nrecall the prior result\n", [turn(action=["read", "markers.txt"]), recall()], variant="markers", allowed=["markers.txt"]),
        case("eof-no-work", ""),
        case("exit-no-work", "/exit\nnot-read\n", script=[{"stop": "exit"}]),
        case("help-exit-no-charge", "/help\n/exit\n", script=[{"help": True}, {"stop": "exit"}]),
        case("help-between-turns", "first direct\n/help\ninspect\n/exit\n", [direct, turn()], script=[{"turn": 0}, {"help": True}, {"turn": 1}, {"stop": "exit"}]),
        case("invalid-between-turns", "first direct\n/unknown\ninspect\n", [direct, turn()], script=[{"turn": 0}, {"refused": "unsupported command; use /help or /exit in line mode"}, {"turn": 1}, {"stop": "EOF"}]),
        case("third-prompt-no-model", "first direct\nsecond direct\n/help\nthird\nnot-read\n", [direct, turn("second direct", action=["final", "SECOND"])], script=[{"turn": 0}, {"turn": 1}, {"help": True}, {"turn_limit": True}], expected_exit=3),
        case("controls-after-two", "first direct\nsecond direct\n/help\n/exit\n", [direct, turn("second direct", action=["final", "SECOND"])], script=[{"turn": 0}, {"turn": 1}, {"help": True}, {"stop": "exit"}]),
        case("crlf-framing", "first direct\r\n/exit\r\n", [direct], script=[{"turn": 0}, {"stop": "exit"}]),
        case("line-without-final-lf", "first direct", [direct]),
        case("raw128-trim", " " * 116 + "first direct\n", [direct]),
        case("raw129-then-valid", " " * 117 + "first direct\nfirst direct\n", [direct], script=[{"raw_limit": True}, {"turn": 0}, {"stop": "EOF"}]),
        case("request128", "x" * 128 + "\n", [turn("x" * 128, action=["final", "BOUNDARY"])]),
        case("raw129-no-truncation", "x" * 129 + "\nfirst direct\n", [direct], script=[{"raw_limit": True}, {"turn": 0}, {"stop": "EOF"}]),
        case("raw8-help-cap", "/help\n" * 9, script=[{"help": True}] * 8 + [{"line_limit": True}], expected_exit=3),
        case("raw8-exit", "/help\n" * 7 + "/exit\n", script=[{"help": True}] * 7 + [{"stop": "exit"}]),
        case("raw8-eof", "/help\n" * 7, script=[{"help": True}] * 7 + [{"stop": "EOF"}]),
        case("raw128-crlf", " " * 116 + "first direct\r\n", [direct]),
        case("raw129-crlf", " " * 117 + "first direct\r\nfirst direct\n", [direct], script=[{"raw_limit": True}, {"turn": 0}, {"stop": "EOF"}]),
        case("raw129-without-lf", "x" * 129, script=[{"raw_limit": True}, {"stop": "EOF"}]),
        case("blank-no-charge", "\nfirst direct\n", [direct], script=[{"refused": "empty input"}, {"turn": 0}, {"stop": "EOF"}]),
        case("first-returned-refusal-stops", "bad action\nnot-read\n", [turn("bad action", action=["write", "docs/a.txt"], kind="child_refusal", calls=2, reads=0, child_error="unsupported action or arity")], expected_exit=3),
        case("second-plan-refusal-no-third", "first direct\nbad plan\nnot-read\n", [direct, turn("bad plan", kind="plan_refusal", plan_raw='["delegate",""]', calls=1, reads=0)], expected_exit=3),
        case("second-returned-tool-refusal", "first direct\ninspect\nnot-read\n", [direct, turn(action=["read", "result257.txt"], kind="tool_refusal", calls=2, tool_error="refused: tool result exceeds 256 display characters")], variant="bounds", allowed=["result257.txt"], expected_exit=3),
    ]
    for label, raw in [("nul", "a\0b"), ("tab", "a\tb"), ("carriage", "a\rb"), ("delete", "a\x7fb"), ("unicode", "世界")]:
        values.append(case("input-" + label, raw + "\nfirst direct\n", [direct], script=[{"refused": "expected printable ASCII single-line input"}, {"turn": 0}, {"stop": "EOF"}]))
    for current in ["plan", "child-first", "child-final", "aggregate"]:
        second = turn("second tool", kind="host_abort", fail_phase=current, fail_mode="unavailable",
                      calls={"plan": 1, "child-first": 2, "child-final": 3, "aggregate": 4}[current],
                      reads=0 if current in {"plan", "child-first"} else 1)
        values.append(case("second-host-" + current, "first direct\nsecond tool\nnot-read\n", [direct, second], expected_exit=3))
    for label, args in [("once-unavailable", ["new", "--allow", "docs/a.txt", "--once", "x"]),
                        ("resume-unavailable", ["resume", "--id", "owned", "--allow", "docs/a.txt"]),
                        ("allow-required", ["new"]), ("help-alone", ["help"])]:
        values.append(case("cli-" + label, "not-read\n", args=args, script=[{"entry": label}], expected_exit=0 if label == "help-alone" else 3))
    values.append(case("pty-prior-help-exit", "/help\ninspect\nrecall the prior result\n/exit\n", [turn(), recall()],
                       transport="pty", script=[{"help": True}, {"turn": 0}, {"turn": 1}, {"stop": "exit"}],
                       pty_sends=["/help\n", "inspect\n", "recall the prior result\n", "/exit\n"]))
    values.append(case("pty-direct-eof", "first direct\n\x04", [direct], transport="pty", pty_sends=["first direct\n", "\x04"]))
    parent_prior = turn("first", action=["final", ""], task='"' * 128, child_text='"' * 256, final_text='"' * 512)
    child_prior = turn("first", action=["final", ""], task="t" * 128, child_text="r" * 256, final_text='"' * 512)
    aggregate_prior = turn("first direct", action=["final", "DIRECT"], final_text='"' * 512)
    values += [
        case("parent-prior-context-exhaustion", "first\n" + '"' * 128 + "\nnot-read\n", [parent_prior, turn('"' * 128, action=["final", "NEVER"], kind="parent_context_refusal", calls=0, reads=0)], expected_exit=3),
        case("zero-child-call-context-exhaustion", "first\nx\nnot-read\n", [child_prior, turn("x", action=["final", "NEVER"], task='"' * 128, kind="child_context_refusal", calls=1, reads=0)], expected_exit=3),
        case("aggregate-prior-context-exhaustion", "first direct\n" + '"' * 128 + "\nnot-read\n", [aggregate_prior, turn('"' * 128, action=["final", ""], task='"' * 128, child_text='"' * 256, kind="aggregate_context_refusal", calls=2, reads=0)], expected_exit=3),
    ]
    if PROTOCOL_READY:
        for value in values:
            if value["transport"] == "pty":
                responses = transcript_parts(value)[1:]
                assert len(responses) == len(value["pty_sends"])
                value["pty_steps"] = [{"send": sent, "response": response, **({"eof_at_line_boundary": True} if sent == "\x04" else {})}
                                      for sent, response in zip(value["pty_sends"], responses)]
    labels = [value["label"] for value in values]
    assert len(values) == len(set(labels)) and len(values) <= 80
    return values


def configured():
    if not PROTOCOL_READY or not BANNER or not HELP or not WRAPPER or len(LIMITS) != 5:
        raise ValueError("chat protocol/API is not frozen; no actual command may be dispatched")


def expected_stdout(item):
    configured()
    return "".join(transcript_parts(item))


def empty_prior():
    return dict.fromkeys(PRIOR_FIELDS, "")


def child_prior(context):
    values = {entry["name"]: entry["text"] for entry in context["history"]
              if entry["role"] == "user" and entry["kind"] == "context" and entry["name"] in PRIOR_FIELDS}
    if values and set(values) != set(PRIOR_FIELDS):
        raise ValueError("selected child prior is incomplete")
    return values or empty_prior()


def recalled(prior):
    return "Recall: " + "|".join(prior[name] for name in PRIOR_FIELDS)


def reply(item, context):
    if "phase" in context:
        if context["phase"] == "plan":
            task = "Recall: " + context["prior"]["outcome"] if item.get("task_from_prior") else item["task"]
            return item.get("plan_raw", encoded(["delegate", task]))
        return item.get("final_text", "Answer: " + context["result"] + "|" + context["tool"] + "|" + context["outcome"])
    if not context["final_only"]:
        action = item["action"]
        if action[0] == "final":
            text = recalled(child_prior(context)) if item.get("child_from_prior") else item.get("child_text", action[1])
            action = ["final", text]
        return item.get("action_raw", encoded(action))
    if "second_raw" in item:
        return item["second_raw"]
    completed = [entry["text"] for entry in context["history"] if entry["role"] == "tool" and entry["kind"] == "complete"]
    if len(completed) != 1:
        raise ValueError("child final requires its one actual current tool outcome")
    return encoded(["final", item.get("child_text", "Seen: " + completed[0])])


def prepare_turn(item, index, prior):
    value = dict(item["turns"][index], allowed=item["allowed"], variant=item["variant"], profile_mode=item["profile_mode"])
    if value.get("task_from_prior"):
        value["task"] = "Recall: " + prior["outcome"]
    if value.get("child_from_prior"):
        value["child_text"] = recalled(prior)
    tool_action = value["action"][0] != "final"
    value["ledger"] = [7, 4, 8192, 1, 4096] if tool_action else [5, 3, 6144, 0, 0]
    if value["kind"] == "plan_refusal":
        value.update(ledger=[1, 1, 2048, 0, 0], diagnostic="invalid bounded delegated task")
    if value["kind"] == "child_refusal":
        value["ledger"] = [3, 2, 4096, 0, 0]
    if value["kind"] == "tool_refusal":
        value["ledger"] = [4, 2, 4096, 1, 4096]
    if value["kind"] == "child_context_refusal":
        value["ledger"] = [2, 1, 2048, 0, 0]
    if value["kind"] == "parent_context_refusal":
        value["ledger"] = [0, 0, 0, 0, 0]
    if value["kind"] == "aggregate_context_refusal":
        value["ledger"] = [4, 2, 4096, 0, 0]
    return value


def selected(value):
    tool, outcome = once.expected_outcome(value)
    result = once.child_answer(value, outcome)
    return {"task": value["task"], "result": result, "tool": tool, "outcome": outcome,
            "answer": once.parent_answer(value, result, tool, outcome)}


def add(left, right):
    return [a + b for a, b in zip(left, right)]


def ledger(state, prefix=""):
    return prefix + "LEDGER " + " ".join(name + "=" + str(value) + "/" + str(limit)
                                          for name, value, limit in zip(["steps", "calls", "tokens", "tools", "scan"], state, LIMITS)) + " reserved_steps=0 reserved_calls=0 reserved_tokens=0 reserved_tools=0 reserved_scan=0\n"


def stop(reason, turns, lines, state):
    return "STOP " + reason + " turns=" + str(turns) + " lines=" + str(lines) + "\n" + ledger(state)


def turn_stdout(value, number, before):
    prefix = "TURN " + str(number) + " USER " + value["request"] + "\n"
    if value["kind"] == "parent_context_refusal":
        return prefix + "REFUSED model context exceeds 2048 serialized characters\n"
    if value["kind"] == "child_context_refusal":
        plan = once.stage("plan", [1, 1, 2048, 0, 0]).replace("STAGE plan child-1 " + once.numbers([1, 1, 2048, 0, 0]), "TURN " + str(number) + " STAGE plan " + once.numbers(add(before, [1, 1, 2048, 0, 0])), 1)
        child = once.stage("child", [2, 1, 2048, 0, 0]).replace("STAGE child child-1 " + once.numbers([2, 1, 2048, 0, 0]), "TURN " + str(number) + " STAGE child " + once.numbers(add(before, [2, 1, 2048, 0, 0])), 1)
        settled = once.settled(value["ledger"]).replace("SETTLED child-1 " + once.numbers(value["ledger"]), "SETTLED child-1 " + once.numbers(add(before, value["ledger"])), 1)
        return prefix + plan + "EVENT main -> child-1 request child-1: " + value["task"] + "\n" + child + "user: " + value["task"] + "\nerror: model context exceeds 2048 serialized characters\n" + settled + "REFUSED child returned failure; no aggregation\n"
    aggregate_refusal = value["kind"] == "aggregate_context_refusal"
    if aggregate_refusal:
        value = dict(value, kind="host_abort", fail_phase="aggregate", ledger=[5, 3, 6144, 0, 0])
    local = once.expected_stdout(value)
    lines = []
    for line in local.splitlines(keepends=True):
        if line.startswith("LEDGER "):
            continue
        if line.startswith("STAGE "):
            phase = line.split(" ")[1]
            if aggregate_refusal and phase == "aggregate":
                continue
            state = [1, 1, 2048, 0, 0] if phase == "plan" else [2, 1, 2048, 0, 0] if phase == "child" else value["ledger"]
            old = "STAGE " + phase + " child-1 " + once.numbers(state)
            line = line.replace(old, "TURN " + str(number) + " STAGE " + phase + " " + once.numbers(add(before, state)), 1)
        if line.startswith("SETTLED "):
            used = value["ledger"][:]
            if value["kind"] in {"success", "final_refusal", "host_abort"}:
                used[0] -= 2; used[1] -= 1; used[2] -= 2048
            line = line.replace("SETTLED child-1 " + once.numbers(used), "SETTLED child-1 " + once.numbers(add(before, used)), 1)
        lines.append(line)
    return prefix + "".join(lines) + ("REFUSED model context exceeds 2048 serialized characters\n" if aggregate_refusal else "")


def transcript_parts(item):
    state, prior, turns, reads = [0] * 5, empty_prior(), 0, 0
    parts = [BANNER]
    for entry in item["script"]:
        if "entry" in entry:
            if entry["entry"] == "help-alone":
                return [HELP]
            return ["REFUSED expected new --allow FILE[,FILE] or standalone help\n" + ledger(state)]
        if entry.get("line_limit"):
            parts.append("REFUSED input read limit reached; start a new in-memory invocation\n" + stop("input limit", turns, reads, state))
            break
        reads += 1
        if "turn" in entry:
            value = prepare_turn(item, entry["turn"], prior)
            turns += 1
            parts.append(turn_stdout(value, turns, state))
            if value["kind"] == "host_abort":
                break
            state = add(state, value["ledger"])
            parts[-1] += ledger(state, "TURN " + str(turns) + " ")
            if value["kind"] != "success":
                parts[-1] += stop("turn failed", turns, reads, state)
                break
            prior = selected(value)
        elif entry.get("help"):
            parts.append(HELP)
        elif "refused" in entry:
            parts.append("REFUSED " + entry["refused"] + "\n")
        elif entry.get("raw_limit"):
            parts.append("REFUSED raw input exceeds 128 characters plus LF/CRLF\n")
        elif entry.get("turn_limit"):
            parts.append("REFUSED turn limit reached\n" + stop("turn limit", turns, reads, state))
            break
        else:
            parts.append(stop(entry["stop"], turns, reads, state))
            break
    return parts


def event(role, kind, text="", name=""):
    return {"role": role, "kind": kind, "name": name, "text": text}


def assert_http(item, records):
    assert len(records) == sum(value["calls"] for value in item["turns"]), "extra HTTP retry, replay or aggregation"
    expected_prior = empty_prior()
    actual_prior = empty_prior()
    systems, observations = {}, []
    for index in range(len(item["turns"])):
        value = prepare_turn(item, index, expected_prior)
        group = [record for record in records if record["turn"] == index + 1]
        assert len(group) == value["calls"], "per-turn HTTP count changed"
        phases = ["plan", "child-first"] + ([] if value["action"][0] == "final" else ["child-final"]) + ["aggregate"]
        current_selected = selected(value) if value["kind"] == "success" or any(record["phase"] == "aggregate" for record in group) else None
        for ordinal, record in enumerate(group):
            assert "observer_error" not in record, "HTTP fixture rejected actual request"
            request, context = record["request"], record["context"]
            phase = record["phase"]
            assert phase == phases[ordinal]
            assert request["model"] == "Qwen3.5-9B-MLX-4bit" and request["max_tokens"] == 2048
            assert request["chat_template_kwargs"] == {"enable_thinking": False}
            assert [message["role"] for message in request["messages"]] == ["system", "user"]
            assert len(request["messages"][1]["content"]) <= 2048, "complete actual context exceeds 2048"
            if phase in {"plan", "aggregate"}:
                expected = {"phase": phase, "request": value["request"], "task": "", "result": "", "tool": "", "outcome": "",
                            "allowed": item["allowed"], "prior": expected_prior}
                if phase == "aggregate":
                    expected.update({key: current_selected[key] for key in ["task", "result", "tool", "outcome"]})
                assert context == expected, "parent did not receive exact selected current/prior data"
                assert context["prior"] == actual_prior, "prior was not the actual preceding successful selection"
                assert "main agent coordinating" in request["messages"][0]["content"]
                role = "main"
            else:
                history = [event("user", "context", value["request"], "original")]
                if expected_prior["task"]:
                    history += [event("user", "context", expected_prior[name], name) for name in PRIOR_FIELDS]
                history += [event("user", "input", value["task"])]
                if phase == "child-final":
                    tool, outcome = once.expected_outcome(value)
                    raw = value.get("action_raw", encoded(value["action"]))
                    history += [event("model", "text", "", "qwen"), event("model", "request", raw, tool), event("tool", "complete", outcome, tool)]
                assert context == {"history": history, "allowed": item["allowed"], "final_only": phase == "child-final"}, "child lost or replayed current/prior evidence"
                assert child_prior(context) == actual_prior
                assert "at most one read-only tool" in request["messages"][0]["content"]
                role = "child"
            system = request["messages"][0]["content"]
            assert role not in systems or systems[role] == system, "agent system changed across phases/turns"
            systems[role] = system
        if value["kind"] == "success":
            aggregate = group[-1]
            assert aggregate["phase"] == "aggregate"
            actual_prior = {key: aggregate["context"][key] for key in ["task", "result", "tool", "outcome"]}
            actual_prior["answer"] = aggregate["response_text"]
            assert actual_prior == current_selected, "actual aggregation/selected answer differs"
            expected_prior = current_selected
        observations.append({"turn": index + 1, "contexts": [record["context"] for record in group],
                             "selected": current_selected if value["kind"] == "success" else None})
    assert len(records) == sum(len(value["contexts"]) for value in observations)
    if "main" in systems and "child" in systems:
        assert systems["main"] != systems["child"], "chat child did not use the separate ETAS agent"
    return {"turn_observations": observations, "contexts": [record["context"] for record in records],
            "final_answers": [record["response_text"] for record in records if record["phase"] == "aggregate"]}


def assert_trace(item, trace, records):
    assert trace.get("schema") == "etas.cli.interpreter-report.v1" and trace.get("incomplete") is not True
    assert trace["termination"]["local_work_settled"] is True
    started = [entry for entry in trace.get("events", []) if entry["kind"] == "host_request_started"]
    finished = {entry["id"]: entry for entry in trace.get("events", []) if entry["kind"] == "host_request_finished"}
    main = "Agentic.infer[nomo.harness.harness_tool_chat.ChatMain, string]"
    child = "Agentic.infer[nomo.agent.model_tool.ToolModel, string]"
    models = {"Model.infer", "Agentic.infer", main, child}
    controls = {"Policy.evaluate", "Approval.request"}
    assert all(entry.get("qualified_action", "").startswith("Console.") or entry.get("qualified_action") in models | controls | {"Fs.read"}
               for entry in started), "unexpected Host authority"
    actual_models = [entry for entry in started if entry.get("qualified_action") in models]
    files = [entry for entry in started if entry.get("request_kind") == "filesystem" or entry.get("qualified_action", "").startswith("Fs.")]
    assert len(records) <= len(actual_models) == len(records), "HTTP/model trace lower bound or no-retry count changed"
    assert len(files) == sum(value["reads"] for value in item["turns"])
    assert all(entry["qualified_action"] == "Fs.read" and entry["request_kind"] == "filesystem" and entry["id"] in finished for entry in files)
    assert all(finished[entry["id"]]["outcome"]["kind"] == "succeeded" for entry in files)
    wanted, agents = [], []
    for value in item["turns"]:
        phases = ["plan", "child-first"] + ([] if value["action"][0] == "final" else ["child-final"]) + ["aggregate"]
        for phase in phases[:value["calls"]]:
            wanted.append("model")
            agents.append(main if phase in {"plan", "aggregate"} else child)
            if phase == "child-first":
                wanted += ["file"] * value["reads"]
    assert all(entry["qualified_action"] in {expected, "Model.infer", "Agentic.infer"} for entry, expected in zip(actual_models, agents))
    actual = ["file" if entry in files else "model" for entry in started if entry in files or entry in actual_models]
    assert actual == wanted, "File replay, extra inference or event ordering changed"
    return {"model_actions": actual_models, "file_actions": files, "file_finished": [finished[entry["id"]] for entry in files]}


def assert_dependence(commands):
    alpha, beta = commands[:2]
    assert alpha["allowed"] == beta["allowed"] and alpha["turns"] == beta["turns"]
    first, second = alpha["turn_observations"], beta["turn_observations"]
    assert first[1]["contexts"][0]["request"] == second[1]["contexts"][0]["request"]
    for name in ["result", "outcome", "answer"]:
        assert first[0]["selected"][name] != second[0]["selected"][name]
        assert first[1]["contexts"][0]["prior"][name] != second[1]["contexts"][0]["prior"][name]
    assert first[1]["selected"]["task"] != second[1]["selected"]["task"]
    assert first[1]["selected"]["result"] != second[1]["selected"]["result"]
    assert alpha["final_answers"][-1] != beta["final_answers"][-1]
    assert len(alpha["file_actions"]) == len(beta["file_actions"]) == 1, "prior tool was replayed"
