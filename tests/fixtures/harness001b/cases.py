"""HARNESS-001B exact black-box observations; no parser or child implementation."""

HARNESS_HELP = (
    "Nomo harness (offline, serial, one child): new --once TEXT\n"
    "Task: 1..256 raw printable ASCII characters; shared maximum 5 steps.\n"
    "Stub/fake echo only: plain text, tool:echo:TEXT, stub:fail, tool:echo:fail.\n"
    "One-shot only; no durable session creation, resume, interactive input, live model or concurrency.\n"
)
DEFAULT_BANNER = "Nomo foundation (stub, in-memory). /help for limits; /exit to quit.\n"
DEFAULT_HELP = (
    "Nomo foundation: --model stub --steps 1..16 --budget 1..16 [--once TEXT]\n"
    "Line mode: /help, /exit; at most 16 input lines; no prompt escapes.\n"
    "Input: printable ASCII, at most 1024 characters; steps: canonical decimal 1..16.\n"
    "Stub: plain text or tool:echo:TEXT; stub:fail / tool:echo:fail simulate failures.\n"
    "Each model call and fake-tool dispatch costs one step; echo round trip needs 3.\n"
    "Limits: per-turn steps default 3; cumulative invocation budget default 16; failures consume steps.\n"
    "History: 32 events / 8192 content characters; reserve four events per turn plus a stop error.\n"
    "Capacity reserves worst-case next-turn content before execution; no history is discarded.\n"
    "recall reads the latest completed tool result; recall:user reads prior input. No tool redispatch.\n"
    "New process = fresh non-durable conversation, never resume.\n"
    "Unavailable in stub entry: persistence, resume, live models, real tools, graceful active-turn cancellation.\n"
    "Opt-in model entry: --flow model --profile gateway-qwen --args --model qwen.\n"
)
WRAPPER = "Nomo harness request refused; see REFUSED output"


def case(label, args, stdout, exit_code=0, *, mode="harness", stdin="", abort="", admitted=False, spent=None):
    return {"label": label, "mode": mode, "args": args, "stdin": stdin,
            "expected_stdout": stdout, "expected_exit": exit_code,
            "expected_abort": abort, "admitted": admitted, "expected_spent": spent}


def admitted(label, task, body, spent, *, refused=False):
    # Each expected child body and charge is supplied explicitly by the fixture.
    status, kind = ("refused", "error") if refused else ("completed", "result")
    final = ("child refused: " if refused else "child result: ") + body
    stdout = (
        "EVENT main -> child-1 request child-1: " + task + "\n"
        "EVENT child-1 -> main " + kind + " child-1: " + body + "\n"
        "EVENT main -> main consume child-1: " + final + "\n"
        "FINAL " + status + ": " + final + "\n"
        "LEDGER maximum=5 spent=" + str(spent) + " reserved=0\n"
    )
    return case(label, ["new", "--once", task], stdout, 3 if refused else 0,
                abort=WRAPPER if refused else "", admitted=True, spent=spent)


def refusal(label, args, diagnostic):
    return case(label, args, "REFUSED " + diagnostic + "\n", 3, abort=WRAPPER)


def cases():
    result = [
        admitted("plain-final", "hello", "stub: hello", 3),
        admitted("fake-echo-round-trip", "tool:echo:hello", "stub received: hello", 5),
        admitted("raw-whitespace-preserved", "  hello  ", "stub: hello", 3),
        admitted("raw-tool-whitespace-preserved", "  tool:echo:hello  ", "stub received: hello", 5),
        admitted("stub-failure-settled", "stub:fail", "stub failure", 3, refused=True),
        admitted("echo-failure-settled", "tool:echo:fail", "fake tool failure", 4, refused=True),
        admitted("unpermitted-read-before-dispatch", "tool:read:secret", "unknown tool", 3, refused=True),
        admitted("malformed-tool-before-dispatch", "tool:echo", "expected tool:NAME:TEXT (no extra colons)", 3, refused=True),
        admitted("extra-colon-before-dispatch", "tool:echo:a:b", "expected tool:NAME:TEXT (no extra colons)", 3, refused=True),
        admitted("empty-echo-before-dispatch", "tool:echo:", "expected tool:NAME:TEXT (no extra colons)", 3, refused=True),
        admitted("empty-context-user-recall", "recall:user", "no prior completed context", 3, refused=True),
        admitted("empty-context-tool-recall", "recall", "no prior completed context", 3, refused=True),
        admitted("raw-task-256", "x" * 256, "stub: " + "x" * 256, 3),
        admitted("raw-task-256-with-spaces", " " + "x" * 254 + " ", "stub: " + "x" * 254, 3),
        admitted("echo-raw-task-256", "tool:echo:" + "x" * 246, "stub received: " + "x" * 246, 5),
        refusal("raw-task-257", ["new", "--once", "x" * 257], "invalid bounded child task"),
        refusal("raw-task-257-not-trimmed-into-admission", ["new", "--once", " " + "x" * 255 + " "], "invalid bounded child task"),
        refusal("parser-1024-runtime-refusal", ["new", "--once", "x" * 1024], "invalid bounded child task"),
        refusal("parser-1025-before-runtime", ["new", "--once", "x" * 1025], "input exceeds 1024 characters"),
        case("help-word-no-delegation", ["help"], HARNESS_HELP),
        case("help-option-no-delegation", ["--help"], HARNESS_HELP),
        refusal("no-command", [], "expected bounded new, resume or help arguments"),
        refusal("new-missing-one-shot", ["new"], "this entry requires new --once TEXT"),
        refusal("once-missing-value", ["new", "--once"], "missing option value"),
        refusal("once-duplicate", ["new", "--once", "a", "--once", "b"], "duplicate --once"),
        refusal("unknown-option", ["new", "--unknown"], "unknown option"),
        refusal("unknown-command", ["other"], "expected new, resume or help"),
        refusal("command-not-trimmed", [" new "], "expected new, resume or help"),
        refusal("combined-help", ["help", "new"], "help must be used alone"),
        refusal("option-help-combined", ["--help", "--once", "hello"], "help must be used alone"),
        refusal("new-resume-selector", ["new", "--latest"], "new forbids a resume selector"),
        refusal("resume-id-unavailable", ["resume", "--id", "session"], "resume is unavailable in the offline harness entry"),
        refusal("resume-id-raw-spaces-unavailable", ["resume", "--id", "  Case/../ID  ", "--once", "hello"], "resume is unavailable in the offline harness entry"),
        refusal("resume-id-128-unavailable", ["resume", "--id", "x" * 128], "resume is unavailable in the offline harness entry"),
        refusal("resume-id-129-parser-refused", ["resume", "--id", "x" * 129], "session ID must be 1..128 printable ASCII characters"),
        refusal("resume-latest-unavailable", ["resume", "--latest"], "resume is unavailable in the offline harness entry"),
        refusal("resume-latest-once-unavailable", ["resume", "--latest", "--once", "tool:echo:hello"], "resume is unavailable in the offline harness entry"),
        refusal("resume-without-selector", ["resume", "--once", "hello"], "resume requires --id ID or --latest"),
        refusal("too-many-arguments", ["new", "--once", "a", "--once", "b", "--latest"], "expected bounded new, resume or help arguments"),
        refusal("empty-prompt", ["new", "--once", ""], "empty input"),
        refusal("spaces-prompt", ["new", "--once", "   "], "empty input"),
        refusal("slash-help-is-not-line-command", ["new", "--once", "/help"], "unsupported command; use /help or /exit in line mode"),
        refusal("slash-exit-is-not-line-command", ["new", "--once", " /exit "], "unsupported command; use /help or /exit in line mode"),
    ]
    for label, text in [("option-looking-once", "--once"), ("option-looking-help", "--help"),
                        ("option-looking-latest", "--latest"), ("command-looking-resume", "resume"),
                        ("printable-punctuation", "!\"#$%&'()*+,-.:;<=>?@[\\]^_`{|}~")]:
        result.append(admitted(label, text, "stub: " + text, 3))
    # NUL is intentionally absent: an OS argv cannot carry it to actual Etas.
    for label, text in [("tab", "a\tb"), ("lf", "a\nb"), ("cr", "a\rb"),
                        ("escape", "a\x1bb"), ("delete", "a\x7fb"), ("unicode", "世界")]:
        result.append(refusal("argv-" + label, ["new", "--once", text], "expected printable ASCII single-line input"))
    result.extend([
        case("default-one-shot", ["--once", "hello"], "user: hello\nassistant: stub: hello\n", mode="default"),
        case("default-echo", ["--once", "tool:echo:hello"], "user: tool:echo:hello\nmodel: tool echo\ntool: echo: hello\nassistant: stub received: hello\n", mode="default"),
        case("default-help", ["--help"], DEFAULT_HELP, mode="default"),
        case("default-line-help-exit", [], DEFAULT_BANNER + DEFAULT_HELP + "bye: exit\n", mode="default", stdin="/help\n/exit\nignored\n"),
        case("default-line-prompt-exit", [], DEFAULT_BANNER + "user: hello\nassistant: stub: hello\nbye: exit\n", mode="default", stdin="hello\n/exit\n"),
        case("default-eof", [], DEFAULT_BANNER + "bye: EOF\n", mode="default"),
        case("default-refusal", ["--resume"], "error: unsupported mode: --resume\n", 3, mode="default", abort="Nomo configuration rejected"),
        case("default-child-error", ["--once", "stub:fail"], "user: stub:fail\nerror: stub failure\n", 3, mode="default", abort="Nomo request failed; see error event"),
    ])
    return result
