"""Exact HARNESS-002A product-entry observations, not a Python agent runner."""

BANNER = "Nomo harness chat (fresh, non-durable). /help for limits; /exit to quit.\n"
HELP = (
    "Nomo harness chat (offline, serial, one child per turn): new\n"
    "Limits: 3 admitted prompts, 16 raw lines, shared maximum 16 steps; tasks 1..256 characters.\n"
    "Context: prior successful user tasks only; /help, /exit and EOF spend no steps.\n"
    "Fresh in-memory only; no resume, one-shot, live model, real tools, concurrency or cancellation.\n"
)
WRAPPER = "Nomo harness chat refused; see REFUSED or STOP output"
INVALID_ASCII = "expected printable ASCII single-line input"
INVALID_TASK = "invalid bounded child task"
LINE_LIMIT = "line limit reached; start a new in-memory invocation"


def turn(number, task, body, spent, *, refused=False):
    prefix = "TURN " + str(number) + " "
    status, kind = ("refused", "error") if refused else ("completed", "result")
    final = ("child refused: " if refused else "child result: ") + body
    return (
        prefix + "EVENT main -> child-1 request child-1: " + task + "\n"
        + prefix + "EVENT child-1 -> main " + kind + " child-1: " + body + "\n"
        + prefix + "EVENT main -> main consume child-1: " + final + "\n"
        + prefix + "FINAL " + status + ": " + final + "\n"
        + prefix + "LEDGER maximum=16 spent=" + str(spent) + " reserved=0\n"
    )


def stop(reason, turns=0, spent=0):
    return "STOP " + reason + " turns=" + str(turns) + " spent=" + str(spent) + "\n"


def refused(reason):
    return "REFUSED " + reason + "\n"


def pipe(label, stdin, transcript, *, args=None, exit_code=0, turns=0, spent=0):
    return {"label": "chat-" + label, "mode": "harness_chat", "transport": "pipe",
            "suite": "HARNESS-002A-chat", "args": ["new"] if args is None else args,
            "stdin": stdin, "expected_stdout": transcript, "expected_exit": exit_code,
            "expected_abort": WRAPPER if exit_code else "", "expected_turns": turns,
            "expected_spent": spent}


def cases():
    alpha = turn(1, "alpha", "stub: alpha", 3)
    beta = turn(2, "beta", "stub: beta", 6)
    recall_alpha = turn(2, "recall:user", "remembered: alpha", 6)
    echo_alpha = turn(1, "tool:echo:alpha", "stub received: alpha", 5)
    result = [
        pipe("eof-no-budget", "", BANNER + stop("EOF")),
        pipe("exit-no-budget", "/exit\nalpha\n", BANNER + stop("exit")),
        pipe("help-exit-no-budget", "/help\n/exit\n", BANNER + HELP + stop("exit")),
        pipe("help-whitespace", " /help \n /exit \n", BANNER + HELP + stop("exit")),
        pipe("alpha-context", "alpha\nrecall:user\n", BANNER + alpha + recall_alpha + stop("EOF", 2, 6), turns=2, spent=6),
        pipe("beta-context-differs", "beta\nrecall:user\n", BANNER + turn(1, "beta", "stub: beta", 3) + turn(2, "recall:user", "remembered: beta", 6) + stop("EOF", 2, 6), turns=2, spent=6),
        pipe("latest-prior-user-context", "alpha\nbeta\nrecall:user\nignored\n", BANNER + alpha + beta + turn(3, "recall:user", "remembered: beta", 9) + stop("turn limit", 3, 9), turns=3, spent=9),
        pipe("prior-task-not-child-answer", "tool:echo:alpha\nrecall:user\n", BANNER + echo_alpha + turn(2, "recall:user", "remembered: tool:echo:alpha", 8) + stop("EOF", 2, 8), turns=2, spent=8),
        pipe("context-includes-successful-recall-task", "alpha\nrecall:user\nrecall:user\n", BANNER + alpha + recall_alpha + turn(3, "recall:user", "remembered: recall:user", 9) + stop("turn limit", 3, 9), turns=3, spent=9),
        pipe("mixed-ledger-3-8-11", "alpha\ntool:echo:beta\ngamma\nfourth\n", BANNER + alpha + turn(2, "tool:echo:beta", "stub received: beta", 8) + turn(3, "gamma", "stub: gamma", 11) + stop("turn limit", 3, 11), turns=3, spent=11),
        pipe("three-echo-ledger-5-10-15", "tool:echo:a\ntool:echo:b\ntool:echo:c\ntool:echo:fourth\n", BANNER + turn(1, "tool:echo:a", "stub received: a", 5) + turn(2, "tool:echo:b", "stub received: b", 10) + turn(3, "tool:echo:c", "stub received: c", 15) + stop("turn limit", 3, 15), turns=3, spent=15),
        pipe("three-plain-turn-cap", "alpha\nbeta\ngamma\nnot-read\n", BANNER + alpha + beta + turn(3, "gamma", "stub: gamma", 9) + stop("turn limit", 3, 9), turns=3, spent=9),
        pipe("fresh-recall-refuses", "recall:user\nalpha\n", BANNER + turn(1, "recall:user", "no prior completed context", 3, refused=True) + stop("child refused", 1, 3), exit_code=3, turns=1, spent=3),
        pipe("no-tool-history-context", "tool:echo:alpha\nrecall\nalpha\n", BANNER + echo_alpha + turn(2, "recall", "no prior completed context", 8, refused=True) + stop("child refused", 2, 8), exit_code=3, turns=2, spent=8),
        pipe("stub-failure-no-retry", "alpha\nstub:fail\nnot-read\n", BANNER + alpha + turn(2, "stub:fail", "stub failure", 6, refused=True) + stop("child refused", 2, 6), exit_code=3, turns=2, spent=6),
        pipe("echo-failure-retains-charge", "alpha\ntool:echo:fail\nnot-read\n", BANNER + alpha + turn(2, "tool:echo:fail", "fake tool failure", 7, refused=True) + stop("child refused", 2, 7), exit_code=3, turns=2, spent=7),
        pipe("unpermitted-tool-before-dispatch", "tool:read:secret\nnot-read\n", BANNER + turn(1, "tool:read:secret", "unknown tool", 3, refused=True) + stop("child refused", 1, 3), exit_code=3, turns=1, spent=3),
        pipe("malformed-tool-refusal", "tool:echo:a:b\nnot-read\n", BANNER + turn(1, "tool:echo:a:b", "expected tool:NAME:TEXT (no extra colons)", 3, refused=True) + stop("child refused", 1, 3), exit_code=3, turns=1, spent=3),
        pipe("help-between-turns-no-charge", "alpha\n/help\nbeta\n/exit\n", BANNER + alpha + HELP + beta + stop("exit", 2, 6), turns=2, spent=6),
        pipe("blank-then-prompt", "\nalpha\n", BANNER + refused("empty input") + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("spaces-then-prompt", "    \nalpha\n", BANNER + refused("empty input") + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("unknown-slash-then-prompt", "/resume\nalpha\n", BANNER + refused("unsupported command; use /help or /exit in line mode") + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("invalid-between-turns-no-charge", "alpha\n/unknown\nbeta\n", BANNER + alpha + refused("unsupported command; use /help or /exit in line mode") + beta + stop("EOF", 2, 6), turns=2, spent=6),
        pipe("crlf-framing", "alpha\r\n/exit\r\n", BANNER + alpha + stop("exit", 1, 3), turns=1, spent=3),
        pipe("final-line-without-lf", "alpha", BANNER + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("task-256-after-framing", "x" * 256 + "\n", BANNER + turn(1, "x" * 256, "stub: " + "x" * 256, 3) + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("task-257-after-framing", "x" * 257 + "\nalpha\n", BANNER + refused(INVALID_TASK) + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("task-256-after-trim", "  " + "x" * 256 + "  \n", BANNER + turn(1, "x" * 256, "stub: " + "x" * 256, 3) + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("large-raw-space-trim-not-truncation", " " * 300 + "alpha" + " " * 300 + "\n", BANNER + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("raw-1024-includes-lf", " " * 1022 + "x\n", BANNER + turn(1, "x", "stub: x", 3) + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("raw-1025-includes-lf", " " * 1023 + "x\nalpha\n", BANNER + refused("input exceeds 1024 characters") + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("raw-1024-includes-crlf", " " * 1021 + "x\r\n", BANNER + turn(1, "x", "stub: x", 3) + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("raw-1025-includes-crlf", " " * 1022 + "x\r\nalpha\n", BANNER + refused("input exceeds 1024 characters") + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("raw-1024-parser-before-task-ceiling", "x" * 1023 + "\nalpha\n", BANNER + refused(INVALID_TASK) + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("raw-1025-parser-ceiling-first", "x" * 1024 + "\nalpha\n", BANNER + refused("input exceeds 1024 characters") + alpha + stop("EOF", 1, 3), turns=1, spent=3),
        pipe("raw-1024-no-final-lf", "x" * 1024, BANNER + refused(INVALID_TASK) + stop("EOF")),
        pipe("raw-16-help-cap", "/help\n" * 17 + "alpha\n", BANNER + HELP * 16 + refused(LINE_LIMIT), exit_code=3),
        pipe("raw-15-help-exit-on-16", "/help\n" * 15 + "/exit\nalpha\n", BANNER + HELP * 15 + stop("exit")),
        pipe("raw-15-invalid-prompt-on-16", "\n" * 15 + "alpha\n/help\n", BANNER + refused("empty input") * 15 + alpha + refused(LINE_LIMIT), exit_code=3, turns=1, spent=3),
        pipe("third-turn-on-raw-16-priority", "/help\n" * 13 + "alpha\nbeta\ngamma\nfourth\n", BANNER + HELP * 13 + alpha + beta + turn(3, "gamma", "stub: gamma", 9) + stop("turn limit", 3, 9), turns=3, spent=9),
    ]
    for label, text in [("nul", "a\x00b"), ("tab", "a\tb"), ("carriage", "a\rb"),
                        ("escape", "a\x1bb"), ("delete", "a\x7fb"), ("unicode", "世界")]:
        result.append(pipe("line-control-" + label, text + "\nalpha\n", BANNER + refused(INVALID_ASCII) + alpha + stop("EOF", 1, 3), turns=1, spent=3))
    for label, args, diagnostic in [
        ("no-command", [], "expected bounded new, resume or help arguments"),
        ("one-shot-unavailable", ["new", "--once", "alpha"], "this line entry requires new without --once"),
        ("resume-id-unavailable", ["resume", "--id", "session"], "resume is unavailable in the offline harness chat"),
        ("resume-latest-unavailable", ["resume", "--latest"], "resume is unavailable in the offline harness chat"),
        ("unknown-option", ["new", "--unknown"], "unknown option"),
        ("combined-help", ["help", "new"], "help must be used alone"),
    ]:
        result.append(pipe(label, "alpha\n", refused(diagnostic), args=args, exit_code=3))
    result += [pipe("standalone-help-word", "alpha\n", HELP, args=["help"]),
               pipe("standalone-help-option", "alpha\n", HELP, args=["--help"])]
    pty_context = pipe("pty-handshake-context-eof", "/help\nalpha\nrecall:user\n\x04", BANNER + HELP + alpha + recall_alpha + stop("EOF", 2, 6), turns=2, spent=6)
    pty_context.update(transport="pty", pty_steps=[
        {"send": "/help\n", "response": HELP},
        {"send": "alpha\n", "response": alpha},
        {"send": "recall:user\n", "response": recall_alpha},
        {"send": "\x04", "response": stop("EOF", 2, 6), "eof_at_line_boundary": True},
    ])
    pty_echo = pipe("pty-handshake-echo-exit", "tool:echo:alpha\n/exit\n", BANNER + echo_alpha + stop("exit", 1, 5), turns=1, spent=5)
    pty_echo.update(transport="pty", pty_steps=[
        {"send": "tool:echo:alpha\n", "response": echo_alpha},
        {"send": "/exit\n", "response": stop("exit", 1, 5)},
    ])
    return result + [pty_context, pty_echo]
