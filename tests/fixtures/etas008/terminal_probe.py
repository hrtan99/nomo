#!/usr/bin/env python3
"""Black-box pipe and pseudo-terminal checks for ETAS-008."""

from __future__ import annotations

import argparse
import errno
import fcntl
import os
import pty
import select
import signal
import subprocess
import termios
import time
from dataclasses import dataclass
from pathlib import Path


ESC = b"\x1b"


@dataclass
class TerminalProcess:
    process: subprocess.Popen[bytes]
    master_fd: int
    output: bytearray

    def read_until(self, marker: bytes, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while marker not in self.output:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"timed out waiting for {marker!r}; output={bytes(self.output)!r}"
                )
            ready, _, _ = select.select([self.master_fd], [], [], remaining)
            if not ready:
                continue
            self._read_available()

    def finish(self, timeout: float = 3.0) -> tuple[int, bytes]:
        deadline = time.monotonic() + timeout
        while self.process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.terminate()
                raise AssertionError(f"terminal child did not exit; output={bytes(self.output)!r}")
            ready, _, _ = select.select([self.master_fd], [], [], remaining)
            if ready:
                self._read_available()
        while True:
            ready, _, _ = select.select([self.master_fd], [], [], 0)
            if not ready:
                break
            if not self._read_available():
                break
        os.close(self.master_fd)
        return self.process.returncode, normalize(bytes(self.output))

    def terminate(self) -> None:
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=2)
        try:
            os.close(self.master_fd)
        except OSError:
            pass

    def _read_available(self) -> bool:
        try:
            chunk = os.read(self.master_fd, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            raise
        if not chunk:
            return False
        self.output.extend(chunk)
        return True


def normalize(output: bytes) -> bytes:
    return output.replace(b"\r\n", b"\n")


def command(etas: str, project: Path, profile: str, *extra: str) -> list[str]:
    return [
        etas,
        "run",
        str(project),
        "--profile",
        profile,
        "--allow-effects",
        "--color",
        "never",
        *extra,
    ]


def assert_plain(*streams: bytes) -> None:
    if any(ESC in stream for stream in streams):
        raise AssertionError("terminal verification observed an ANSI escape byte")


def pipe_case(
    name: str,
    argv: list[str],
    input_data: bytes,
    expected_code: int,
) -> tuple[bytes, bytes]:
    result = subprocess.run(
        argv,
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=5,
        check=False,
    )
    if result.returncode != expected_code:
        raise AssertionError(
            f"{name}: exit={result.returncode}, stdout={result.stdout!r}, "
            f"stderr={result.stderr!r}"
        )
    assert_plain(result.stdout, result.stderr)
    print(f"CASE {name}\nEXIT {result.returncode}\nRESULT pass\n")
    return result.stdout, result.stderr


def spawn_terminal(argv: list[str]) -> TerminalProcess:
    master_fd, slave_fd = pty.openpty()
    attrs = termios.tcgetattr(slave_fd)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)

    def configure_child_terminal() -> None:
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    process = subprocess.Popen(
        argv,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        preexec_fn=configure_child_terminal,
        close_fds=True,
    )
    os.close(slave_fd)
    return TerminalProcess(process, master_fd, bytearray())


def assert_ordered(output: bytes, markers: list[bytes]) -> None:
    position = 0
    for marker in markers:
        next_position = output.find(marker, position)
        if next_position < 0:
            raise AssertionError(f"missing ordered marker {marker!r} in {output!r}")
        position = next_position + len(marker)


def pipe_budget_gap(argv: list[str]) -> None:
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    output = bytearray()
    deadline = time.monotonic() + 3
    while b"READY\n" not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            process.kill()
            raise AssertionError("budget probe did not reach its blocking read")
        ready, _, _ = select.select([process.stdout], [], [], remaining)
        if ready:
            output.extend(os.read(process.stdout.fileno(), 4096))
    time.sleep(0.35)
    if process.poll() is not None:
        raise AssertionError("console read honored the expected-gap time budget")
    process.stdin.write(b"late\nsecond\n")
    process.stdin.close()
    process.wait(timeout=3)
    output.extend(process.stdout.read())
    error = process.stderr.read()
    assert_plain(bytes(output), error)
    if process.returncode != 3 or b"execution time budget is exhausted" not in error:
        raise AssertionError(
            f"unexpected post-read budget result: exit={process.returncode}, "
            f"stdout={bytes(output)!r}, stderr={error!r}"
        )
    print(
        "CASE non_tty_read_budget\n"
        "RESULT expected-gap\n"
        "DETAIL read_line remained blocked past 100ms and reported budget exhaustion only after input arrived\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--etas", required=True)
    parser.add_argument("--line-project", required=True, type=Path)
    parser.add_argument("--single-line-project", required=True, type=Path)
    parser.add_argument("--approval-project", required=True, type=Path)
    args = parser.parse_args()

    line_command = command(args.etas, args.line_project, "line")
    single_line_command = command(args.etas, args.single_line_project, "line")
    approval_command = command(args.etas, args.approval_project, "prompt")

    stdout, stderr = pipe_case(
        "non_tty_stdlib_multiline", line_command, b"alpha\nbeta", 0
    )
    if stdout != b"READY\nFIRST<alpha\n>\nSECOND<" or stderr != b"ERR_DONE\n":
        raise AssertionError(f"stdlib multi-line gap changed: {stdout!r}, {stderr!r}")
    print(
        "CASE stdlib_repeated_line_io\n"
        "RESULT expected-gap\n"
        "DETAIL second read_line and its dependent stdout writes were skipped\n"
    )

    stdout, stderr = pipe_case("non_tty_single_line", single_line_command, b"alpha\n", 0)
    expected = b"READY\nINPUT<alpha\n>\n"
    if stdout != expected or stderr != b"ERR_DONE\n":
        raise AssertionError(f"unexpected single-line streams: {stdout!r}, {stderr!r}")

    stdout, stderr = pipe_case("non_tty_eof", single_line_command, b"", 0)
    if stdout != b"READY\nINPUT<>\n" or stderr != b"ERR_DONE\n":
        raise AssertionError(f"unexpected EOF result: {stdout!r}, {stderr!r}")

    stdout, stderr = pipe_case(
        "non_tty_approval_fails_closed", approval_command, b"yes\n", 3
    )
    if stdout or b"Type `yes`" in stderr:
        raise AssertionError("non-TTY approval prompted or executed the guarded action")
    if b"console policy approval was denied" not in stderr:
        raise AssertionError(f"missing non-TTY denial diagnostic: {stderr!r}")

    terminal = spawn_terminal(single_line_command)
    try:
        terminal.read_until(b"READY")
        os.write(terminal.master_fd, b"alpha\n")
        code, output = terminal.finish()
    except BaseException:
        terminal.terminate()
        raise
    if code != 0:
        raise AssertionError(f"TTY line case exited {code}: {output!r}")
    assert_plain(output)
    assert_ordered(
        output,
        [b"READY\n", b"INPUT<alpha\n>\n", b"ERR_DONE\n"],
    )
    print("CASE tty_single_line\nEXIT 0\nRESULT pass\n")

    terminal = spawn_terminal(approval_command)
    try:
        terminal.read_until(b"Type `yes` to approve:")
        os.write(terminal.master_fd, b"yes\n")
        code, output = terminal.finish()
    except BaseException:
        terminal.terminate()
        raise
    if code != 0 or b"APPROVED_ACTION\n" not in output:
        raise AssertionError(f"TTY approval did not execute: exit={code}, output={output!r}")
    assert_plain(output)
    assert_ordered(output, [b"Etas approval requested:", b"Type `yes`", b"APPROVED_ACTION"])
    print("CASE tty_approval_yes\nEXIT 0\nRESULT pass\n")

    terminal = spawn_terminal(approval_command)
    try:
        terminal.read_until(b"Type `yes` to approve:")
        os.write(terminal.master_fd, b"y\n")
        code, output = terminal.finish()
    except BaseException:
        terminal.terminate()
        raise
    if code != 3 or b"APPROVED_ACTION" in output.splitlines():
        raise AssertionError(f"TTY short-y result changed: exit={code}, output={output!r}")
    assert_plain(output)
    print(
        "CASE tty_approval_short_y\n"
        "EXIT 3\n"
        "RESULT expected-gap\n"
        "DETAIL Etas accepts literal yes, not the P0 y/N short form\n"
    )

    terminal = spawn_terminal(approval_command)
    try:
        terminal.read_until(b"Type `yes` to approve:")
        os.write(terminal.master_fd, b"\n")
        code, output = terminal.finish()
    except BaseException:
        terminal.terminate()
        raise
    if code != 3 or b"APPROVED_ACTION" in output.splitlines():
        raise AssertionError(f"TTY default denial failed: exit={code}, output={output!r}")
    if b"console policy approval was denied" not in output:
        raise AssertionError(f"TTY denial diagnostic missing: {output!r}")
    assert_plain(output)
    print("CASE tty_approval_default_deny\nEXIT 3\nRESULT pass\n")

    terminal = spawn_terminal(single_line_command)
    try:
        terminal.read_until(b"READY")
        children_path = Path(f"/proc/{terminal.process.pid}/task/{terminal.process.pid}/children")
        if children_path.read_text(encoding="utf-8").strip():
            raise AssertionError("console-only Etas process unexpectedly owns a child")
        os.write(terminal.master_fd, b"\x03")
        code, output = terminal.finish(timeout=2)
    except BaseException:
        terminal.terminate()
        raise
    if code != -signal.SIGINT or b"INPUT<" in output:
        raise AssertionError(f"TTY interrupt result changed: exit={code}, output={output!r}")
    assert_plain(output)
    print(
        "CASE tty_input_interrupt\n"
        "EXIT signal:SIGINT\n"
        "RESULT bounded-process-cancel\n"
        "DETAIL terminal interrupt terminates the CLI process; no structured turn-cancel result is emitted\n"
    )

    pipe_budget_gap(
        command(args.etas, args.single_line_project, "line", "--budget-time", "100ms")
    )
    print("ETAS-008 terminal probe completed: 7 pass, 1 bounded cancel, 3 expected-gaps")


if __name__ == "__main__":
    main()
