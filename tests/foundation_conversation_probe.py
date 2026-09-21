#!/usr/bin/env python3
"""FOUNDATION-002 black-box assertions; the Etas runtime owns all conversation behavior."""
from foundation_probe import BANNER, HELP, answer, run_case, terminal_case

EOF = "bye: EOF\n"
EXHAUSTED = "error: invocation step budget exhausted\n"
EVENT_FULL = "error: history event capacity exhausted; start a new invocation\n"
CONTENT_FULL = "error: history content capacity exhausted; start a new invocation\n"


def tool(text):
    return f"user: tool:echo:{text}\nmodel: tool echo\ntool: echo: {text}\nassistant: stub received: {text}\n"


def recall(text, request="recall"):
    return f"user: {request}\nassistant: remembered: {text}\n"


def main():
    run_case("context_two_turn_no_redispatch", ["--budget", "4"], BANNER + tool("hello") + recall("hello") + EOF, data="tool:echo:hello\nrecall\n")
    run_case("context_prior_user", [], BANNER + answer("earlier") + recall("earlier", "recall:user") + EOF, data="earlier\nrecall:user\n")
    run_case("context_latest_result", [], BANNER + tool("first") + tool("second") + recall("second") + EOF, data="tool:echo:first\ntool:echo:second\nrecall\n")
    failed = "user: tool:echo:fail\nmodel: tool echo\nerror: fake tool failure\n"
    run_case("context_failure_not_completed", [], BANNER + tool("kept") + failed + recall("kept") + EOF, data="tool:echo:kept\ntool:echo:fail\nrecall\n")
    run_case("context_no_success", [], BANNER + failed + "user: recall\nerror: no prior completed context\n" + EOF, data="tool:echo:fail\nrecall\n")
    run_case("context_repeated_read", ["--budget", "5"], BANNER + tool("hello") + recall("hello") * 2 + EOF, data="tool:echo:hello\nrecall\nrecall\n")
    run_case("new_process_not_resume", ["--once", "recall"], "user: recall\nerror: no prior completed context\n", 3)
    run_case("new_process_new_budget", ["--budget", "1", "--once", "hello"], answer("hello"))
    run_case("invocation_budget_across_turns", ["--budget", "4"], BANNER + tool("hello") + recall("hello") + "user: hello\n" + EXHAUSTED + EOF, data="tool:echo:hello\nrecall\nhello\n")
    run_case("invocation_before_dispatch", ["--budget", "1", "--once", "tool:echo:hello"], "user: tool:echo:hello\nmodel: tool echo\n" + EXHAUSTED, 4)
    run_case("invocation_after_tool", ["--budget", "2", "--once", "tool:echo:hello"], "user: tool:echo:hello\nmodel: tool echo\ntool: echo: hello\n" + EXHAUSTED, 4)
    partial = "user: tool:echo:hello\nmodel: tool echo\ntool: echo: hello\nerror: step limit exhausted\n"
    run_case("per_turn_reset_not_cumulative_reset", ["--steps", "2", "--budget", "4"], BANNER + partial + recall("hello") + answer("hello") + "user: hello\n" + EXHAUSTED + EOF, data="tool:echo:hello\nrecall\nhello\nhello\n")
    run_case("model_failure_charged", ["--budget", "1"], BANNER + "user: stub:fail\nerror: stub failure\nuser: hello\n" + EXHAUSTED + EOF, data="stub:fail\nhello\n")
    run_case("tool_failure_charged", ["--budget", "2"], BANNER + failed + "user: hello\n" + EXHAUSTED + EOF, data="tool:echo:fail\nhello\n")
    run_case("unknown_tool_charged", ["--budget", "2"], BANNER + "user: tool:missing:x\nmodel: tool missing\nerror: unknown tool\nuser: hello\n" + EXHAUSTED + EOF, data="tool:missing:x\nhello\n")
    run_case("invalid_and_help_not_charged", ["--budget", "1"], BANNER + "error: empty input\nerror: unsupported command; use /help or /exit in line mode\nerror: input exceeds 1024 characters\n" + HELP + answer("hello") + "bye: exit\n", data="\n/resume\n" + "x" * 1025 + "\n/help\nhello\n/exit\n")
    run_case("help_exit_after_budget", ["--budget", "1"], BANNER + answer("hello") + HELP + "bye: exit\n", data="hello\n/help\n/exit\n")
    run_case("budget_duplicate", ["--budget", "1", "--budget", "2"], "error: duplicate --budget\n", 2)
    run_case("budget_missing", ["--budget"], "error: missing option value\n", 2)
    for value in ["0", "17", "-1", "abc", "2147483648", "01", "+1"]:
        run_case("budget_invalid_" + value, ["--budget", value], "error: budget must be canonical decimal in 1..16\n", 2)
    for value in range(1, 17):
        run_case("budget_canonical_" + str(value), ["--budget", str(value), "--once", "hello"], answer("hello"))
    run_case("all_configuration_flags", ["--model", "stub", "--steps", "3", "--budget", "3", "--once", "tool:echo:hello"], tool("hello"))
    # 27 existing events + four reserved turn events + one terminal slot = 32.
    run_case("history_event_reservation_boundary", [], BANNER + "error: empty input\n" + answer("hello") * 14 + EOF, data="\n" + "hello\n" * 14)
    run_case("history_event_reject_before_dispatch", [], BANNER + answer("hello") * 14 + EVENT_FULL, 4, "hello\n" * 14 + "tool:echo:unstarted\nhello\n")
    # Prior content = 2 * (1000 user + 1006 assistant) = 4012.
    # 4012 + (4 * 1021 + 32) + 64 = 8192: exact reservation boundary.
    prefix = BANNER + answer("x" * 1000) * 2
    data_prefix = ("x" * 1000 + "\n") * 2
    run_case("history_content_reservation_boundary", [], prefix + answer("y" * 1021) + EOF, data=data_prefix + "y" * 1021 + "\n")
    unstarted = "tool:echo:" + "y" * 1012
    assert len(unstarted) == 1022
    run_case("history_content_reject_before_dispatch", [], prefix + CONTENT_FULL, 4, data_prefix + unstarted + "\nhello\n")
    run_case("new_process_after_capacity_stop", ["--once", "recall"], "user: recall\nerror: no prior completed context\n", 3)
    terminal_case([("tool:echo:hello", tool("hello")), ("recall", recall("hello")), ("/exit", "bye: exit\n")], ["--budget", "4"], "pty_context_no_redispatch")


if __name__ == "__main__":
    main()
