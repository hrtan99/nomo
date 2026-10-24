"""Bounded Model Host reply fixtures and independent exact route observations."""
import json

TOKEN = "NOMO_HARNESS_MODEL_LOOPBACK_NOT_A_SECRET"
WRAPPER = "Nomo model harness refused; see REFUSED output"
HELP = (
    "Nomo model harness: new --once TEXT (fresh, one-shot, one depth-one child).\n"
    "Main plan -> child response -> main aggregate; request/task 1..128, child 1..256, final 1..512 printable ASCII.\n"
    "Plan: [\"delegate\",\"TASK\"], raw encoding <=384; each complete Prompt.data <=2048 characters.\n"
    "Shared maximum 5 steps / 3 calls / 6144 token-allowance units; 2048 per attempted call, no refunds or retries.\n"
    "Token allowance is not measured usage. Host aborts may leave only the last precharged STAGE marker.\n"
    "No resume, line mode, real tools, persistence, concurrency or cancellation.\n"
)


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def stage(number):
    name, steps = [("plan", 1), ("child", 3), ("aggregate", 5)][number - 1]
    return ("STAGE " + name + " child-1 steps=" + str(steps) + " calls=" + str(number)
            + " tokens=" + str(number * 2048) + " reserved_steps=" + str(5 - steps)
            + " reserved_calls=" + str(3 - number) + " reserved_tokens=" + str((3 - number) * 2048) + "\n")


def ledger(number):
    steps = [0, 1, 3, 5][number]
    return ("LEDGER steps=" + str(steps) + "/5 calls=" + str(number) + "/3 tokens="
            + str(number * 2048) + "/6144 reserved_steps=0 reserved_calls=0 reserved_tokens=0\n")


def context(phase="plan", request="alpha", task="", result=""):
    return {"phase": phase, "request": request, "task": task, "result": result}


def base(label, **changes):
    item = {"label": "model-" + label, "kind": "success", "request": "alpha", "task": "work:alpha",
            "args": ["new", "--once", "alpha"], "calls": 3, "last_stage": 3,
            "child_tag": "child", "profile_mode": "normal"}
    item.update(changes)
    return item


def cases():
    escaped = '"\\' * 64
    padding = encoded(["delegate", "bounded"])
    raw384 = padding[:-1] + " " * (384 - len(padding)) + "]"
    assert len(raw384) == 384
    values = [
        base("data-dependent-alpha"),
        base("data-dependent-beta", request="beta", task="work:beta", args=["new", "--once", "beta"]),
        base("changed-child-changes-aggregation", child_tag="alternate"),
        base("request-task-128-escaping", request=escaped, task=escaped, args=["new", "--once", escaped], child_text="escaped-child"),
        base("child256-final512", child_text="x" * 256, final_text="y" * 512),
        base("raw-plan384-accepted", task="bounded", plan_raw=raw384),
        base("literal-raw-spaces-preserved", request="  alpha  ", task="  bounded  ", args=["new", "--once", "  alpha  "]),
        base("child-action-looking-data", child_text=encoded(["delegate", "never-dispatch-this"])),
    ]
    invalid_plans = {
        "raw385": raw384[:-1] + " ]",
        "nested": '["delegate",["nested"]]',
        "nonstring": '["delegate",3]',
        "arity": '["delegate","x","extra"]',
        "unsupported-verb": '["read","x"]',
        "empty-task": '["delegate",""]',
        "task129": encoded(["delegate", "x" * 129]),
        "escaped-control": encoded(["delegate", "a\nb"]),
        "escaped-unicode": encoded(["delegate", "世界"]),
        "trailing-data": '["delegate","x"] extra',
        "raw-control": '["delegate","a\nb"]',
        "invalid-json": '["delegate",,"x"]',
    }
    for name, raw in invalid_plans.items():
        diagnostic = "expected bounded flat single-line delegation JSON"
        if name == "unsupported-verb":
            diagnostic = "unsupported delegation verb or arity"
        elif name in {"empty-task", "task129", "escaped-control", "escaped-unicode"}:
            diagnostic = "invalid bounded delegated task"
        elif name == "invalid-json":
            diagnostic = "invalid delegation JSON"
        values.append(base("plan-" + name, kind="plan_refusal", plan_raw=raw, calls=1, last_stage=1, diagnostic=diagnostic))
    for label, body in [("empty", ""), ("257", "x" * 257), ("control", "a\nb")]:
        # The Model Host rejects empty content before the product sees a string.
        values.append(base("child-" + label, kind="host_abort" if body == "" else "child_refusal", child_text=body, calls=2, last_stage=2))
    for label, body in [("empty", ""), ("513", "x" * 513), ("unicode", "世界")]:
        values.append(base("final-" + label, kind="host_abort" if body == "" else "final_refusal", final_text=body))
    for label, args, diagnostic in [
        ("request129", ["new", "--once", "x" * 129], "request requires 1..128 printable ASCII characters"),
        ("missing-once", ["new"], "this entry requires new --once TEXT"),
        ("resume-id", ["resume", "--id", "session"], "resume is unavailable in the model harness"),
        ("resume-latest", ["resume", "--latest"], "resume is unavailable in the model harness"),
        ("no-command", [], "expected bounded new, resume or help arguments"),
        ("argv-control", ["new", "--once", "a\nb"], "expected printable ASCII single-line input"),
    ]:
        values.append(base(label, kind="pre_refusal", args=args, diagnostic=diagnostic, calls=0, last_stage=0))
    values.append(base("standalone-help", kind="help", args=["help"], calls=0, last_stage=0))
    for number, phase in enumerate(["plan", "child", "aggregate"], 1):
        for mode in ["unavailable", "malformed", "missing_usage", "wrong_shape", "token_overrun", "timeout"]:
            values.append(base("host-" + phase + "-" + mode, kind="host_abort", fail_stage=number,
                               fail_mode=mode, calls=number, last_stage=number))
    for mode in ["missing", "denied", "connection"]:
        values.append(base("host-" + mode, kind="host_abort", profile_mode=mode, calls=0, last_stage=0 if mode == "missing" else 1))
    for request in ["alpha", "beta"]:
        values.append(base("existing-text-model-" + request, kind="provider_smoke", request=request,
                           args=["--model", "qwen", "--once", request], calls=1, last_stage=0))
    return values


def expected_task(item):
    return item["task"]


def expected_child(item):
    return item.get("child_text", item["child_tag"] + ":" + expected_task(item) + "|" + item["request"])


def expected_final(item):
    return item.get("final_text", "answer:" + expected_child(item))


def prefix(item, number):
    text = stage(1) if number else ""
    if number >= 2:
        text += "EVENT main -> child-1 request child-1: " + expected_task(item) + "\n" + stage(2)
    if number >= 3:
        text += ("EVENT child-1 -> main result child-1: " + expected_child(item) + "\n"
                 + "EVENT main -> main consume child-1: " + expected_child(item) + "\n" + stage(3))
    return text


def expected_stdout(item):
    kind = item["kind"]
    if kind == "help":
        return HELP
    if kind == "pre_refusal":
        return "REFUSED " + item["diagnostic"] + "\n" + ledger(0)
    if kind == "provider_smoke":
        return "user: " + item["request"] + "\nmodel: text qwen\nassistant: text:" + item["request"] + "\n"
    text = prefix(item, item["last_stage"])
    if kind == "host_abort":
        return text
    if kind == "success":
        return text + "FINAL " + expected_final(item) + "\n" + ledger(3)
    diagnostic = item.get("diagnostic", "invalid bounded child result" if kind == "child_refusal" else "invalid bounded final answer")
    return text + "REFUSED " + diagnostic + "\n" + ledger(item["last_stage"])


def pure_cases():
    empty_context = context("", "", "", "")
    initial = {"steps": 0, "calls": 0, "tokens": 0}
    def check(label, mode, **extra):
        item = {"label": label, "mode": mode, "text": "", "maximum": 128,
                "context": empty_context, "ledger": initial, "accepted": False,
                "expected_text": "", "expected": initial}
        item.update(extra)
        return item
    values = [check("bounded128", "bounded", text="x" * 128, accepted=True),
              check("bounded129", "bounded", text="x" * 129),
              check("bounded-spaces", "bounded", text="   "),
              check("bounded-control", "bounded", text="a\x00b"),
              check("bounded-nonascii", "bounded", text="é"),
              check("bounded-invalid-cap513", "bounded", text="x", maximum=513),
              check("bounded-final512", "bounded", text="x" * 512, maximum=512, accepted=True)]
    values.extend([check("bounded-child-empty", "bounded", maximum=256),
                   check("bounded-final-empty", "bounded", maximum=512)])
    # Keys/JSON quoting add 47 characters for the four empty Context fields.
    overhead = len(encoded(empty_context))
    for length in [2048, 2049]:
        current = context("", "", "", "x" * (length - overhead))
        assert len(encoded(current)) == length
        values.append(check("context-serialized-" + str(length), "context", context=current,
                            accepted=length == 2048, expected_text="" if length == 2048 else "model context exceeds 2048 serialized characters"))
    for length in [2048, 2050]:
        # Every quote doubles when encoded. Include metadata before choosing n.
        current = context("", "", "", '"' * ((length - overhead) // 2))
        actual = len(encoded(current))
        values.append(check("context-escaping-" + str(actual), "context", context=current,
                            accepted=actual <= 2048, expected_text="" if actual <= 2048 else "model context exceeds 2048 serialized characters"))
    for name, ledger_value, accepted, expected in [
        ("fresh", initial, True, {"steps": 1, "calls": 1, "tokens": 2048}),
        ("second", {"steps": 2, "calls": 1, "tokens": 2048}, True, {"steps": 3, "calls": 2, "tokens": 4096}),
        ("third", {"steps": 4, "calls": 2, "tokens": 4096}, True, {"steps": 5, "calls": 3, "tokens": 6144}),
        ("completed", {"steps": 5, "calls": 3, "tokens": 6144}, False, initial),
        ("negative", {"steps": -1, "calls": 0, "tokens": 0}, False, initial),
        ("overflow", {"steps": 2147483647, "calls": 2147483647, "tokens": 2147483647}, False, initial),
        ("token-mismatch", {"steps": 1, "calls": 1, "tokens": 2047}, False, initial),
        ("calls-ahead", {"steps": 0, "calls": 1, "tokens": 2048}, False, initial),
    ]:
        values.append(check("charge-call-" + name, "call", ledger=ledger_value, accepted=accepted, expected=expected))
    for name, ledger_value, accepted, expected in [
        ("delegation", {"steps": 1, "calls": 1, "tokens": 2048}, True, {"steps": 2, "calls": 1, "tokens": 2048}),
        ("consumption", {"steps": 3, "calls": 2, "tokens": 4096}, True, {"steps": 4, "calls": 2, "tokens": 4096}),
        ("over-reserved", {"steps": 2, "calls": 0, "tokens": 0}, False, initial),
        ("completed", {"steps": 5, "calls": 3, "tokens": 6144}, False, initial),
    ]:
        values.append(check("charge-boundary-" + name, "boundary", ledger=ledger_value, accepted=accepted, expected=expected))
    values.append(check("decode-escaped-task", "decode", text=encoded(["delegate", '"\\' * 64]), accepted=True, expected_text='"\\' * 64))
    values.append(check("decode-spaces-preserved", "decode", text=encoded(["delegate", "  task  "]), accepted=True, expected_text="  task  "))
    for item in cases():
        if item["kind"] == "plan_refusal":
            values.append(check("pure-" + item["label"], "decode", text=item["plan_raw"]))
    return values
