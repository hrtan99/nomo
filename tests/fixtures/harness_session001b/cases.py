"""Independent cross-process continuation inputs, transcript and wire oracles."""
import importlib.util
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "harness_session001/cases.py"
spec = importlib.util.spec_from_file_location("accepted_first_checkpoint_cases_for_continuation", BASE)
first = importlib.util.module_from_spec(spec)
spec.loader.exec_module(first)
chat, encoded = first.chat, first.encoded
TOKEN = first.TOKEN
REGION = "nomo-harness-successor-v1"
ID, NEXT, WORKSPACE = first.ID, "owned-harness-successor", first.WORKSPACE
PROTOCOL_READY = True
MAXIMUM = first.MAXIMUM
ADMISSION_ACTIONS = ["Memory.read"] * 5 + ["Memory.write"] + ["Memory.read"] * 4
MEMORY = {"continue_success": (17, 4), "continue_failure": (11, 2), "continue_abort": (9, 1),
          "continue_admitted": (5, 1), "continue_settled": (14, 2), "continue_pending": (15, 3),
          "continue_published": (16, 4), "successor_show": (10, 0), "duplicate": (4, 0),
          "corrupt_predecessor": (2, 0), "preflight_failure": (3, 0), "stale_version": (9, 1)}
DUPLICATE_DIAGNOSTIC = "predecessor continuation already admitted; no retry"
BINDING_REFUSALS = [
    ("id", "wrong-predecessor", "checkpoint owner or phase mismatch; no retry", (1, 0)),
    ("workspace", "wrong-workspace", "checkpoint owner or phase mismatch; no retry", (1, 0)),
    ("allow", "docs/b.txt", "checkpoint owner or phase mismatch; no retry", (1, 0)),
    ("successor", ID, "successor must have a distinct checkpoint ID", (0, 0)),
]


def case(label, *, first_turn=None, second_turn=None, kind="roundtrip", **changes):
    value = {"label": "continuation-" + label, "kind": kind, "id": ID, "successor": NEXT,
             "workspace": WORKSPACE, "allowed": ["docs/a.txt"], "variant": "alpha", "profile_mode": "normal",
             "first": chat.turn("Original user request", action=["read", "docs/a.txt"]) if first_turn is None else first_turn,
             "second": chat.recall() if second_turn is None else second_turn}
    value.update(changes)
    return value


def cases():
    direct = chat.turn("Original direct request", action=["final", "DIRECT"])
    values = [
        case("prior-alpha-no-replay"), case("prior-beta-no-replay", variant="beta"),
        case("direct-direct", first_turn=direct, second_turn=chat.turn("Second direct request", action=["final", "SECOND"])),
        case("direct-new-read", first_turn=direct, second_turn=chat.turn("Read the allowed file now")),
        case("read-new-read", second_turn=chat.turn("Explicitly read the file again")),
        case("search-two-recall", allowed=["docs/a.txt", "docs/b.txt"],
             first_turn=chat.turn("Original search request", action=["search", "NEEDLE", "docs/a.txt", "docs/b.txt"], reads=2)),
        case("empty-outcome-recall", variant="empty", allowed=["empty.txt"],
             first_turn=chat.turn("Original empty request", action=["read", "empty.txt"])),
        case("plan-refusal-consumes-admission", kind="turn_failure", first_turn=direct,
             second_turn=chat.turn("Reject invalid plan", kind="plan_refusal", plan_raw='["delegate",""]', calls=1, reads=0)),
        case("child-refusal-consumes-admission", kind="turn_failure", first_turn=direct,
             second_turn=chat.turn("Reject invalid child", action=["write", "docs/a.txt"], kind="child_refusal", calls=2, reads=0,
                                   child_error="unsupported action or arity")),
        case("host-abort-retains-admission", kind="turn_failure", first_turn=direct,
             second_turn=chat.turn("Host abort", kind="host_abort", fail_phase="child-final", fail_mode="unavailable", calls=3, reads=1)),
        case("admission-insert-refused", kind="write_failure", trigger="admitted", first_turn=direct),
        case("settlement-update-refused", kind="write_failure", trigger="settled", first_turn=direct),
        case("successor-pending-refused", kind="write_failure", trigger="pending", first_turn=direct),
        case("successor-published-refused", kind="write_failure", trigger="published", first_turn=direct),
        case("stale-predecessor-after-admission", kind="stale_version", first_turn=direct),
    ]
    parent_prior = chat.turn("First escaped prior", action=["final", ""], task='"' * 128,
                             child_text='"' * 256, final_text='"' * 512)
    child_prior = chat.turn("First large prior", action=["final", ""], task="t" * 128,
                            child_text="r" * 256, final_text='"' * 512)
    aggregate_prior = chat.turn("First aggregate prior", action=["final", "DIRECT"], final_text='"' * 512)
    values += [
        case("parent-context-refused", kind="preflight_failure", first_turn=parent_prior,
             second_turn=chat.turn('"' * 128, action=["final", "NEVER"], kind="parent_context_refusal", calls=0, reads=0)),
        case("child-context-refused", kind="turn_failure", first_turn=child_prior,
             second_turn=chat.turn("x", action=["final", "NEVER"], task='"' * 128, kind="child_context_refusal", calls=1, reads=0)),
        case("aggregate-context-refused", kind="turn_failure", first_turn=aggregate_prior,
             second_turn=chat.turn('"' * 128, action=["final", ""], task='"' * 128, child_text='"' * 256,
                                   kind="aggregate_context_refusal", calls=2, reads=0)),
    ]
    for mutation, diagnostic in [
        ("usage-reset", "checkpoint completed usage mismatch"),
        ("maximum-refill", "checkpoint number exceeds bound"),
        ("admitted", "checkpoint is not completed and settled"),
        ("unresolved", "checkpoint is not completed and settled"),
        ("allowlist", "checkpoint identity or workspace binding mismatch"),
        ("record-order", "invalid checkpoint planning records"),
        ("completed-outcome", "checkpoint child records and selected result disagree"),
    ]:
        values.append(case("corrupt-predecessor-" + mutation, kind="corrupt_predecessor", mutation=mutation,
                           diagnostic=diagnostic, seed="continuation-prior-alpha-no-replay"))
    for mutation, diagnostic in [
        ("wire-version", "unsupported successor format"),
        ("usage-reset", "successor cumulative usage or limits mismatch"),
        ("maximum-change", "successor cumulative usage or limits mismatch"),
        ("third-admitted", "successor is not completed and settled"),
        ("prior-record", "selected prior history changed"),
        ("opaque-version", "successor admission, publication or predecessor mismatch"),
        ("wrong-lineage", "successor identity or predecessor binding mismatch"),
        ("envelope-phase", "successor admission, publication or predecessor mismatch"),
    ]:
        values.append(case("corrupt-successor-" + mutation, kind="corrupt_successor", mutation=mutation,
                           diagnostic=diagnostic, seed="continuation-prior-alpha-no-replay"))
    assert len(values) == len({value["label"] for value in values}) and len(values) <= 40
    return values


def first_case(item):
    return dict(item, turn=item["first"], kind="roundtrip")


def prepared(item, phase):
    model = dict(item, turns=[item["first"], item["second"]])
    initial = chat.prepare_turn(model, 0, chat.empty_prior())
    if phase == "save":
        return initial
    return chat.prepare_turn(model, 1, chat.selected(initial))


def prior(item):
    return chat.selected(prepared(item, "save"))


def model_case(item, phase, attempted=True):
    return {"label": item["label"], "turns": [item["first"] if phase == "save" else item["second"]] if attempted else [],
            "allowed": item["allowed"], "variant": item["variant"], "profile_mode": item["profile_mode"],
            "transport": "pipe", "stdin": ""}


def records(item):
    value, before = prepared(item, "continue"), prior(item)
    observed = chat.selected(value)
    raw_plan = value.get("plan_raw", encoded(["delegate", value["task"]]))
    events = [chat.event("user", "request", value["request"]), chat.event("main", "plan", raw_plan),
              chat.event("main", "delegate", value["task"], "child-1")]
    child = [chat.event("user", "context", value["request"], "original")]
    child += [chat.event("user", "context", before[name], name) for name in chat.PRIOR_FIELDS]
    child += [chat.event("user", "input", value["task"]), chat.event("model", "text", "", "qwen")]
    if observed["tool"]:
        child += [chat.event("model", "request", value.get("action_raw", encoded(value["action"])), observed["tool"]),
                  chat.event("tool", "complete", observed["outcome"], observed["tool"]), chat.event("model", "text", "", "qwen")]
    child += [chat.event("assistant", "final", observed["result"])]
    events += child + [chat.event("main", "consume", observed["result"], "child-1")]
    if observed["tool"]:
        events += [chat.event("main", "tool", observed["outcome"], observed["tool"])]
    events += [chat.event("main", "answer", observed["answer"])]
    assert len(events) == (18 if observed["tool"] else 14)
    return events


def body_fields(item, predecessor_body, version):
    value = prepared(item, "continue")
    observed = chat.selected(value)
    usage = chat.add(prepared(item, "save")["ledger"], value["ledger"])
    fields = [REGION, item["successor"], item["workspace"], item["allowed"][0], item["allowed"][1] if len(item["allowed"]) == 2 else "",
              predecessor_body, version, value["request"], value["task"], observed["result"], observed["tool"],
              observed["outcome"], observed["answer"], *map(str, usage), *map(str, MAXIMUM), "2", "completed", "true", str(len(records(item)))]
    assert len(fields) == 27
    for entry in records(item):
        fields += [entry[name] for name in ["role", "kind", "name", "text"]]
    return fields


def body(item, predecessor_body, version):
    return encoded(body_fields(item, predecessor_body, version))


def arguments(item, phase, **changes):
    identity = {"id": item["id"], "successor": item["successor"], "workspace": item["workspace"], "allow": ",".join(item["allowed"])}
    identity.update(changes)
    args = [value for key in ["id", "successor", "workspace", "allow"] for value in ["--" + key, identity[key]]]
    if phase == "continue":
        args += ["--once", item["second"]["request"]]
    return args


def continue_stdout(item):
    if item["kind"] == "preflight_failure":
        return "REFUSED model context exceeds 2048 serialized characters\n"
    if item["kind"] == "stale_version":
        return "REFUSED predecessor version or body changed; no retry\n"
    prefix = chat.turn_stdout(prepared(item, "continue"), 2, prepared(item, "save")["ledger"])
    if item["second"]["kind"] == "host_abort":
        return prefix
    if item["kind"] == "turn_failure":
        return prefix + "REFUSED Harness continuation did not complete; admission retained and successor not published\n"
    if item["kind"] == "write_failure":
        return ("" if item["trigger"] == "admitted" else prefix) + "REFUSED successor commit refused; no retry\n"
    return prefix + "SAVED Harness successor " + item["successor"] + " from " + item["id"] + "\n"


def failed_show(item):
    if item["kind"] == "preflight_failure" or item.get("trigger") == "admitted":
        return "successor admission missing", 4
    if item.get("trigger") == "published":
        return "successor admission, publication or predecessor mismatch", 5
    return "successor missing; no completed continuation", 5


def configured():
    if not PROTOCOL_READY:
        raise ValueError("continuation storage/entry protocol not frozen; no actual dispatch")
