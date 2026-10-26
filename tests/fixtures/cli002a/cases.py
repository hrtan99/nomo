"""Independent public lifecycle inputs and expected user-facing transcripts."""
import importlib.util
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "harness_session001b/cases.py"
spec = importlib.util.spec_from_file_location("accepted_continuation_lifecycle_oracles", BASE)
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
chat, first, encoded = prior.chat, prior.first, prior.encoded
TOKEN, REGION, MAXIMUM = prior.TOKEN, prior.REGION, prior.MAXIMUM
PROTOCOL_READY = True
SOURCE_MODULES = 61
FLOWS = {name: name for name in ["init", "new", "resume", "show", "help"]}
PROFILES = {"init": "harness-checkpoint-create", "new": "harness-checkpoint-save",
            "resume": "harness-checkpoint-save", "show": "harness-checkpoint-show", "help": "foundation"}
HELP = "\n".join([
    "Nomo sessions: init -> new -> resume -> show.",
    "Run: etas run PROJECT --flow COMMAND --allow-effects --args OPTIONS. Commands select their existing profiles.",
    "init: --id ID --workspace BIND --allow FILE[,FILE]",
    "new: --id ID --workspace BIND --allow FILE[,FILE] --once TEXT",
    "resume: --id FIRST --successor SECOND --workspace BIND --allow FILE[,FILE] --once TEXT",
    "show first: --id FIRST --workspace BIND --allow FILE[,FILE]",
    "show successor: --id FIRST --successor SECOND --workspace BIND --allow FILE[,FILE]",
    "Help: use --flow help [--args COMMAND], or pass help/--help alone after --args for any command.",
    "Initialize one fresh private project-owned store. Keep IDs, workspace label and ordered allowed files explicit.",
    "Each first checkpoint admits at most one second turn; successors allow show only. No latest selection or third turn.",
    "Failed, pending or unknown work is not completed. Admission may be consumed; do not retry automatically.",
    "Show reads saved data with no model/File configuration, tool replay or Memory mutation.",
    "NEXT arrays contain a --flow entry followed by literal --args values; replace placeholders.",
    "Bounds: IDs/workspace and request at most 128 printable ASCII characters; allow one/two files of at most 48 characters, at most 97 raw characters.",
]) + "\n"


def case(label, **changes):
    value = prior.case(label, **changes)
    value["label"] = "lifecycle-" + label
    return value


def cases():
    direct = chat.turn("Original direct request", action=["final", "DIRECT"])
    return [
        case("prior-alpha-no-replay"), case("prior-beta-no-replay", variant="beta"),
        case("direct-direct", first_turn=direct, second_turn=chat.turn("Second direct request", action=["final", "SECOND"])),
        case("direct-new-read", first_turn=direct, second_turn=chat.turn("Read the allowed file now")),
        case("read-new-read", second_turn=chat.turn("Explicitly read the file again")),
        case("search-two-recall", allowed=["docs/a.txt", "docs/b.txt"],
             first_turn=chat.turn("Original search request", action=["search", "NEEDLE", "docs/a.txt", "docs/b.txt"], reads=2)),
        case("literal-selector-data", id="--successor", workspace="--once", first_turn=chat.turn("--help", action=["final", "FIRST"]),
             second_turn=chat.turn("--successor", action=["final", "SECOND"])),
        case("new-returned-failure", kind="new_failure", first_turn=chat.turn("bad first plan", kind="plan_refusal", plan_raw='["delegate",""]', calls=1, reads=0)),
        case("new-published-refusal", kind="new_publication_failure", trigger="published", first_turn=direct),
        case("resume-returned-failure", kind="resume_failure", first_turn=direct,
             second_turn=chat.turn("bad second plan", kind="plan_refusal", plan_raw='["delegate",""]', calls=1, reads=0)),
        case("resume-published-refusal", kind="resume_publication_failure", trigger="published", first_turn=direct),
        case("resume-host-abort", kind="resume_failure", first_turn=direct,
             second_turn=chat.turn("Host abort", kind="host_abort", fail_phase="child-final", fail_mode="unavailable", calls=3, reads=1)),
    ]


def arguments(item, action, *, successor_show=False, **changes):
    if action in {"resume", "show"} and (successor_show or action == "resume"):
        return prior.arguments(item, "continue" if action == "resume" else "successor-show", **changes)
    value = dict(item, turn=item["first"])
    return first.arguments(value, saving=action == "new", **changes)


def prehost_cases():
    value = cases()[0]
    checkpoint_arity = "expected --id ID --workspace BIND --allow FILE[,FILE] and save --once TEXT"
    successor_arity = "expected --id OLD --successor NEW --workspace BIND --allow FILE[,FILE] and continue --once TEXT"
    values = [{"label": "help-" + action, "action": action, "args": ["--help"], "help": True}
              for action in FLOWS]
    values += [{"label": "help-default", "action": "help", "args": [], "help": True},
               {"label": "help-word", "action": "new", "args": ["help"], "help": True},
               {"label": "help-selectors", "action": "help", "args": ["--id", "owned"], "diagnostic": "session help accepts no selectors"}]
    for topic, indexes in [("init", [2, 8, 13, 12]), ("new", [3, 9, 10, 13, 12]),
                           ("resume", [4, 9, 10, 13, 12]), ("show", [5, 6, 11, 13, 12])]:
        lines = HELP.splitlines()
        values.append({"label": "help-topic-" + topic, "action": "help", "args": [topic], "help": True,
                       "stdout": "\n".join(lines[index] for index in indexes) + "\n"})
    values.append({"label": "help-unknown-topic", "action": "help", "args": ["latest"],
                   "diagnostic": "unsupported session help topic; use init, new, resume or show"})
    for action in ["init", "new", "resume", "show"]:
        values.append({"label": "missing-" + action, "action": action, "args": [],
                       "diagnostic": successor_arity if action == "resume" else checkpoint_arity})
    for action in ["new", "resume", "show"]:
        args = arguments(value, action)
        args[0] = "--latest"
        values.append({"label": "latest-" + action, "action": action, "args": args,
                       "diagnostic": "unknown successor option" if action == "resume" else "unknown checkpoint option"})
    values += [
        {"label": "request129", "action": "new", "args": arguments(value, "new")[:-1] + ["x" * 129],
         "diagnostic": "question requires 1..128 printable ASCII chars, not only spaces"},
        {"label": "duplicate-id", "action": "new", "args": ["--id", "first", "--id", "second", "--allow", "docs/a.txt", "--once", "request"],
         "diagnostic": "duplicate checkpoint option"},
        {"label": "show-no-once", "action": "show", "args": arguments(value, "new"), "diagnostic": "unknown successor option"},
        {"label": "resume-distinct-required", "action": "resume", "args": arguments(value, "resume", successor=value["id"]),
         "diagnostic": "successor must have a distinct checkpoint ID"},
        {"label": "init-three-files", "action": "init", "args": arguments(value, "init", allow="a,b,c"),
         "diagnostic": "expected one or two allowed files"},
        {"label": "new-extra-turn", "action": "new", "args": arguments(value, "new") + ["--turns", "3"], "diagnostic": checkpoint_arity},
    ]
    assert len(values) == len({item["label"] for item in values})
    return values


def next_line(entry, args=()):
    return "NEXT " + encoded([entry, *args]) + "\n"


def identity_args(item, successor=False):
    return arguments(item, "show", successor_show=successor)


def success_hints(item, action, *, successor=False):
    if action == "init":
        return ("SESSION " + encoded([item["id"], "initialized", "remaining-turns", "2"]) + "\n" +
                next_line(FLOWS["new"], [*identity_args(item), "--once", "<request>"]))
    if action == "new":
        following = ["--id", item["id"], "--successor", "<successor-id>", "--workspace", item["workspace"],
                     "--allow", ",".join(item["allowed"]), "--once", "<request>"]
        return "SESSION " + encoded([item["id"], "published-first", "remaining-turns", "1"]) + "\n" + next_line(FLOWS["resume"], following)
    if action == "resume":
        values = [item["successor"], "published-successor", "predecessor", item["id"], "remaining-turns", "0"]
        return "SESSION " + encoded(values) + "\n" + next_line(FLOWS["show"], identity_args(item, True))
    if successor:
        values = [item["successor"], "displayed-successor", "predecessor", item["id"], "remaining-turns", "0"]
        return "SESSION " + encoded(values) + "\n" + next_line(FLOWS["show"], identity_args(item, True))
    return ("SESSION " + encoded([item["id"], "displayed-first"]) + "\n" +
            "GUIDANCE Displaying a first checkpoint does not establish an unused continuation.\n" + next_line(FLOWS["help"]))


def failure_hints(item, action, *, successor=False):
    selected = item["successor"] if action == "resume" or successor else item["id"]
    text = ("SESSION " + encoded([selected, "completion-unconfirmed"]) + "\n" +
            "GUIDANCE No new completed publication is confirmed. Do not automatically retry; show accepts published data only.\n")
    return text + next_line(FLOWS["show"], identity_args(item, action == "resume" or successor))


def parse_refusal(action, diagnostic):
    return "REFUSED session " + action + ": " + diagnostic + "\n" + next_line(FLOWS["help"])


def low_first(item):
    kind = "turn_failure" if item["kind"] == "new_failure" else "publication_failure" if item["kind"] == "new_publication_failure" else "roundtrip"
    return dict(item, kind=kind, turn=item["first"])


def new_stdout(item):
    success = item["kind"] not in {"new_failure", "new_publication_failure"}
    return first.save_stdout(low_first(item)) + (success_hints(item, "new") if success else failure_hints(item, "new"))


def resume_stdout(item):
    if item["second"]["kind"] == "host_abort":
        value = dict(item, kind="turn_failure")
        return prior.continue_stdout(value)
    kind = "turn_failure" if item["kind"] == "resume_failure" else "write_failure" if item["kind"] == "resume_publication_failure" else "roundtrip"
    return prior.continue_stdout(dict(item, kind=kind)) + (success_hints(item, "resume") if kind == "roundtrip" else failure_hints(item, "resume"))


def configured():
    if not PROTOCOL_READY:
        raise ValueError("public lifecycle output/effect protocol not frozen; no actual dispatch")
