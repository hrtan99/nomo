#!/usr/bin/env python3
"""Foundation baseline black-box tests; no product behavior lives in this harness."""
import os
from collections import Counter
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
COMMAND = ["etas", "run", str(ROOT), "--allow-effects", "--args"]
BANNER = "Nomo foundation (stub, in-memory). /help for limits; /exit to quit.\n"
HELP = (
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


def run_case(name, args, expected, code=0, data=""):
    completed = subprocess.run(COMMAND + args, input=data.encode(), capture_output=True, timeout=12)
    # Internal categories (invalid=2, adapter=3, exhausted=4) all abort as CLI exit 3.
    expected_exit = 3 if code else 0
    assert completed.returncode == expected_exit, (name, completed.returncode, completed.stderr)
    assert completed.stdout.decode() == expected, (name, completed.stdout)
    if code:
        assert b"analysis::ExecutionAborted" in completed.stderr and b"Nomo " in completed.stderr, (name, completed.stderr)
    else:
        assert completed.stderr == b"", (name, completed.stderr)
    print("PASS " + name, flush=True)


def answer(text):
    return f"user: {text}\nassistant: stub: {text}\n"


def terminal_case(steps=None, args=None, label="pty_ordered_line_help_exit"):
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    settings[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    process = subprocess.Popen(COMMAND + (args or []), stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def read_until(expected):
        deadline = time.monotonic() + 8
        while expected.encode() not in output.replace(b"\r\n", b"\n"):
            remaining = deadline - time.monotonic()
            assert remaining > 0 and select.select([master], [], [], remaining)[0], bytes(output)
            chunk = os.read(master, 8192)
            assert chunk, bytes(output)
            output.extend(chunk)

    try:
        read_until(BANNER)
        expected = BANNER
        for request, response in steps or [("hello", answer("hello")), ("/help", HELP), ("/exit", "bye: exit\n")]:
            os.write(master, (request + "\n").encode())
            expected += response
            read_until(expected)
        process.wait(timeout=3)
        assert process.returncode == 0
        assert output.replace(b"\r\n", b"\n").decode() == expected
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)
        os.close(master)
    print("PASS " + label, flush=True)


def main():
    phase1 = subprocess.run(["etas", "check", "--phase1", str(ROOT)], capture_output=True, timeout=12)
    assert phase1.returncode == 1, (phase1.returncode, phase1.stderr)
    assert phase1.stdout == b"checked 25 files\n", phase1.stdout
    # MODEL-TOOL-001 adds five Host-bearing flows: one Console helper, one
    # Agentic/Console attempt and three Agentic/Console/FileIO compositions.
    # The pure contract/path policy adds no Host requirement; old flows retain theirs.
    assert phase1.stderr.count(b"warning[effect::RuntimeRequiredInPhase1]") == 36, phase1.stderr
    supports = re.findall(rb"warning\[effect::RuntimeRequiredInPhase1\]: checked HIR execution requires host support: \{([^}]+)\}", phase1.stderr)
    assert Counter(supports) == {b'Console': 8, b'Agentic, Console': 4, b'Console, FileIO': 4,
                                 b'FileIO': 4, b'DurableMemory': 10, b'DurableMemory, Console': 3,
                                 b'Agentic, Console, FileIO': 3}, phase1.stderr
    assert b"error[" not in phase1.stderr and b"{Console}" in phase1.stderr, phase1.stderr
    print("PASS phase1_requires_console_host", flush=True)
    effects = subprocess.run(["etas", "effects", str(ROOT), "--flow", "main"], capture_output=True, timeout=12, check=True)
    rows = re.findall(r"requested actions: \[([^\]]*)\]", effects.stdout.decode())
    assert len(rows) == 1, ('default main must have exactly one effect report', effects.stdout)
    actions = {action for action in rows[0].split(", ") if action}
    assert actions == {"Console.stdin_read_line", "Console.stdout_write"}, effects.stdout
    print("PASS console_only_actions", flush=True)
    run_case("final_only", ["--once", "hello"], answer("hello"))
    run_case("configured_limit", ["--steps", "1", "--model", "stub", "--once", "hello"], answer("hello"))
    run_case("trim", ["--once", "  hello  "], answer("hello"))
    run_case("unsupported_unicode", ["--once", "你好"], "error: expected printable ASCII single-line input\n", 2)
    tool = "user: tool:echo:hello\nmodel: tool echo\ntool: echo: hello\nassistant: stub received: hello\n"
    run_case("tool_round_trip", ["--once", "tool:echo:hello"], tool)
    run_case("max_steps", ["--steps", "16", "--once", "tool:echo:hello"], tool)
    run_case("unknown_tool", ["--once", "tool:missing:hello"], "user: tool:missing:hello\nmodel: tool missing\nerror: unknown tool\n", 3)
    run_case("stub_failure", ["--once", "stub:fail"], "user: stub:fail\nerror: stub failure\n", 3)
    run_case("tool_failure", ["--once", "tool:echo:fail"], "user: tool:echo:fail\nmodel: tool echo\nerror: fake tool failure\n", 3)
    run_case("limit_before_dispatch", ["--steps", "1", "--once", "tool:echo:hello"], "user: tool:echo:hello\nmodel: tool echo\nerror: step limit exhausted\n", 4)
    run_case("limit_after_tool", ["--steps", "2", "--once", "tool:echo:hello"], "user: tool:echo:hello\nmodel: tool echo\ntool: echo: hello\nerror: step limit exhausted\n", 4)
    for value in ["0", "-1", "17", "abc", "2147483648", "01", "+1"]:
        run_case("invalid_steps_" + value, ["--steps", value], "error: steps must be canonical decimal in 1..16\n", 2)
    for value in range(2, 16):
        run_case("canonical_steps_" + str(value), ["--steps", str(value), "--once", "hello"], answer("hello"))
    for flag in ["--resume", "--persist", "--live", "--tools", "--cancel"]:
        run_case("unsupported_" + flag, [flag], "error: unsupported mode: " + flag + "\n", 2)
    run_case("unsupported_model", ["--model", "live"], "error: unsupported model; only stub is available\n", 2)
    run_case("unknown_option", ["--wat"], "error: unknown option\n", 2)
    run_case("missing_value", ["--steps"], "error: missing option value\n", 2)
    for flag, value in [("--model", "stub"), ("--steps", "3"), ("--once", "hello")]:
        run_case("duplicate_" + flag, [flag, value, flag, value], "error: duplicate " + flag + "\n", 2)
    run_case("too_many_args", ["x"] * 10, "error: too many arguments\n", 2)
    run_case("combined_help", ["--help", "x"], "error: --help must be used alone\n", 2)
    run_case("empty_input", ["--once", ""], "error: empty input\n", 2)
    run_case("whitespace", ["--once", " \t "], "error: empty input\n", 2)
    run_case("oversize", ["--once", "x" * 1025], "error: input exceeds 1024 characters\n", 2)
    run_case("input_at_limit", ["--once", "x" * 1024], answer("x" * 1024))
    run_case("multiline", ["--once", "a\nb"], "error: expected printable ASCII single-line input\n", 2)
    run_case("escape", ["--once", "a\x1bb"], "error: expected printable ASCII single-line input\n", 2)
    for control in ["\t", "\r", "\x07", "\x7f"]:
        run_case("control_" + str(ord(control)), ["--once", "a" + control + "b"], "error: expected printable ASCII single-line input\n", 2)
    punctuation = "punctuation: !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    run_case("printable_punctuation", ["--once", punctuation], answer(punctuation))
    run_case("malformed_tool", ["--once", "tool:echo"], "user: tool:echo\nerror: expected tool:NAME:TEXT (no extra colons)\n", 3)
    run_case("help", ["--help"], HELP)
    run_case("eof", [], BANNER + "bye: EOF\n")
    run_case("exit", [], BANNER + "bye: exit\n", data="/exit\nignored\n")
    run_case("line_help", [], BANNER + HELP + "bye: EOF\n", data="/help\n")
    run_case("multiple_turns", [], BANNER + answer("hello") + tool + "bye: EOF\n", data="hello\ntool:echo:hello\n")
    run_case("final_line_without_newline", [], BANNER + answer("hello") + "bye: EOF\n", data="hello")
    run_case("empty_line_not_eof", [], BANNER + "error: empty input\n" + answer("hello") + "bye: EOF\n", data="\nhello\n")
    run_case("line_error_then_next", [], BANNER + "user: stub:fail\nerror: stub failure\n" + answer("hello") + "bye: EOF\n", data="stub:fail\nhello\n")
    for command in ["/help", "/exit"]:
        run_case("oversize_command_" + command[1:], [], BANNER + "error: input exceeds 1024 characters\n" + answer("hello") + "bye: EOF\n", data=" " * 1024 + command + "\nhello\n")
    run_case("line_raw_limit", [], BANNER + answer("x" * 1023) + "bye: EOF\n", data="x" * 1023 + "\n")
    run_case("line_raw_oversize", [], BANNER + "error: input exceeds 1024 characters\n" + answer("hello") + "bye: EOF\n", data="x" * 1024 + "\nhello\n")
    run_case("unsupported_line_mode", [], BANNER + "error: unsupported command; use /help or /exit in line mode\nbye: EOF\n", data="/resume\n")
    run_case("bounded_line_count", [], BANNER + HELP * 16 + "error: line limit reached; start a new in-memory invocation\n", 4, "/help\n" * 17)
    terminal_case()


if __name__ == "__main__":
    main()
