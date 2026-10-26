"""Fresh owned Harness checkpoint scenarios and independent wire observations."""
import importlib.util
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "harness_tool002a/cases.py"
spec = importlib.util.spec_from_file_location("accepted_chat_checkpoint_oracles", BASE)
chat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chat)
encoded = chat.encoded
TOKEN = chat.TOKEN
REGION = "nomo-harness-checkpoint-v1"
ID = "owned-harness-checkpoint"
WORKSPACE = "owned-workspace-binding-not-authority"
MAXIMUM = [14, 8, 16384, 2, 8192]
PROTOCOL_READY = True


def case(label, *, kind="roundtrip", turn=None, **changes):
    value = {"label": "checkpoint-" + label, "kind": kind, "id": ID, "workspace": WORKSPACE,
             "allowed": ["docs/a.txt"], "variant": "alpha", "profile_mode": "normal",
             "turn": chat.turn("Original user request", action=["read", "docs/a.txt"]) if turn is None else turn}
    value.update(changes)
    return value


def cases():
    direct = chat.turn("Original direct request", action=["final", "DIRECT"])
    values = [case("read-alpha"), case("read-beta", variant="beta"), case("direct", turn=direct),
              case("search-two", allowed=["docs/a.txt", "docs/b.txt"], turn=chat.turn("Original search request", action=["search", "NEEDLE", "docs/a.txt", "docs/b.txt"], reads=2)),
              case("empty-outcome", variant="empty", allowed=["empty.txt"], turn=chat.turn("Original empty request", action=["read", "empty.txt"])),
              case("markers", variant="markers", allowed=["markers.txt"], turn=chat.turn("Original marker request", action=["read", "markers.txt"])),
              case("escape-bounds", turn=chat.turn('"\\' * 64, action=["final", ""], task="t" * 128, child_text='"' * 256, final_text='"' * 512)),
              case("literal-flag-value", turn=chat.turn("--id", action=["final", "FLAG DATA"]), reverse_args=True)]
    values += [
        case("bad-plan-consumes-owner", kind="turn_failure", turn=chat.turn("bad plan", kind="plan_refusal", plan_raw='["delegate",""]', calls=1, reads=0)),
        case("bad-child-consumes-owner", kind="turn_failure", turn=chat.turn("bad child", action=["write", "docs/a.txt"], kind="child_refusal", calls=2, reads=0, child_error="unsupported action or arity")),
        case("host-abort-consumes-owner", kind="turn_failure", turn=chat.turn("Host abort", kind="host_abort", fail_phase="child-final", fail_mode="unavailable", calls=3, reads=1)),
        case("pending-insert-fails", kind="publication_failure", trigger="pending"),
        case("publication-update-fails", kind="publication_failure", trigger="published"),
    ]
    for mutation, diagnostic in [
        ("envelope-format", "checkpoint identity or format mismatch"),
        ("pending", "checkpoint not published; no recovery or retry"),
        ("owner-ready", "checkpoint owner or phase mismatch; no retry"),
        ("wire-version", "unsupported checkpoint format"),
        ("malformed", "checkpoint encoded shape or bounds invalid"),
        ("oversize", "checkpoint encoded shape or bounds invalid"),
        ("usage-reset", "checkpoint completed usage mismatch"),
        ("maximum-refill", "checkpoint number exceeds bound"),
        ("admitted", "checkpoint is not completed and settled"),
        ("lifecycle", "checkpoint is not completed and settled"),
        ("unresolved", "checkpoint is not completed and settled"),
        ("record-count", "checkpoint record count disagrees with framing"),
        ("original-request", "invalid checkpoint planning records"),
        ("delegated-task", "invalid checkpoint planning records"),
        ("record-order", "invalid checkpoint planning records"),
        ("child-original", "child original request or task history changed"),
        ("completed-outcome", "checkpoint child records and selected result disagree"),
        ("parent-answer", "invalid checkpoint consumption records"),
        ("allowlist", "checkpoint identity or workspace binding mismatch"),
    ]:
        values.append(case("corrupt-" + mutation, kind="corrupt", seed="checkpoint-read-alpha", mutation=mutation, diagnostic=diagnostic))
    assert len(values) == len({value["label"] for value in values}) and len(values) <= 64
    return values


def model_case(item, *, attempted=True):
    return {"label": item["label"], "turns": [item["turn"]] if attempted else [], "allowed": item["allowed"],
            "variant": item["variant"], "profile_mode": item["profile_mode"], "transport": "pipe", "stdin": ""}


def prepared(item):
    return chat.prepare_turn(model_case(item), 0, chat.empty_prior())


def records(item):
    value = prepared(item)
    observed = chat.selected(value)
    raw_plan = value.get("plan_raw", encoded(["delegate", value["task"]]))
    result = [chat.event("user", "request", value["request"]), chat.event("main", "plan", raw_plan),
              chat.event("main", "delegate", value["task"], "child-1")]
    child = [chat.event("user", "context", value["request"], "original"), chat.event("user", "input", value["task"]),
             chat.event("model", "text", "", "qwen")]
    if observed["tool"]:
        child += [chat.event("model", "request", value.get("action_raw", encoded(value["action"])), observed["tool"]),
                  chat.event("tool", "complete", observed["outcome"], observed["tool"]), chat.event("model", "text", "", "qwen")]
    child.append(chat.event("assistant", "final", observed["result"]))
    result += child + [chat.event("main", "consume", observed["result"], "child-1")]
    if observed["tool"]:
        result.append(chat.event("main", "tool", observed["outcome"], observed["tool"]))
    result.append(chat.event("main", "answer", observed["answer"]))
    assert len(result) == (13 if observed["tool"] else 9)
    return result


def body_fields(item):
    value = prepared(item)
    observed = chat.selected(value)
    fields = [REGION, item["id"], item["workspace"], item["allowed"][0], item["allowed"][1] if len(item["allowed"]) == 2 else "",
              value["request"], value["task"], observed["result"], observed["tool"], observed["outcome"], observed["answer"],
              *map(str, value["ledger"]), *map(str, MAXIMUM), "1", "completed", "true", str(len(records(item)))]
    assert len(fields) == 25
    for record in records(item):
        fields += [record[name] for name in ["role", "kind", "name", "text"]]
    return fields


def body(item):
    return encoded(body_fields(item))


def arguments(item, saving=False, **changes):
    identity = {"id": item["id"], "workspace": item["workspace"], "allow": ",".join(item["allowed"])}
    identity.update(changes)
    order = ["allow", "workspace", "id"] if item.get("reverse_args") else ["id", "workspace", "allow"]
    args = [value for key in order for value in ["--" + key, identity[key]]]
    if saving:
        args += ["--once", item["turn"]["request"]]
    return args


def turn_prefix(item):
    return chat.turn_stdout(prepared(item), 1, [0] * 5)


def save_stdout(item):
    text = turn_prefix(item)
    if item["turn"]["kind"] == "host_abort":
        return text
    if item["kind"] == "turn_failure":
        return text + "REFUSED Harness turn did not complete; checkpoint not published\n"
    if item["kind"] == "publication_failure":
        return text + "REFUSED checkpoint commit refused; no retry\n"
    return text + "SAVED Harness checkpoint " + item["id"] + "\n"


def corrupt_body(item, original):
    mutation = item["mutation"]
    if mutation == "malformed":
        return "not-json"
    if mutation == "oversize":
        return "x" * 65537
    fields = list(original)
    changes = {"wire-version": (0, "unsupported-harness-checkpoint-v2"), "usage-reset": (11, "0"),
               "maximum-refill": (16, "15"), "admitted": (21, "2"), "lifecycle": (22, "running"),
               "unresolved": (23, "false"), "record-count": (24, "12"), "original-request": (5, "FORGED ORIGINAL"),
               "delegated-task": (6, "FORGED TASK"), "child-original": (25 + 3 * 4 + 3, "FORGED CHILD ORIGINAL"),
               "completed-outcome": (9, "complete: FORGED"), "parent-answer": (10, "FORGED ANSWER"),
               "allowlist": (4, "docs/b.txt")}
    if mutation == "record-order":
        fields[25:29], fields[29:33] = fields[29:33], fields[25:29]
    else:
        index, text = changes[mutation]
        fields[index] = text
    return encoded(fields)


def configured():
    if not PROTOCOL_READY or any(value.get("diagnostic") is None for value in cases() if value["kind"] == "corrupt"):
        raise ValueError("checkpoint codec diagnostics are not frozen; no actual dispatch")
