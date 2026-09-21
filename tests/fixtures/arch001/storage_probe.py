#!/usr/bin/env python3
"""ARCH-001-S1 test orchestration only; all normal record writes are Etas."""
import json
import os
from pathlib import Path
import select
import signal
import sqlite3
import subprocess
import tempfile
import time

PROJECT = Path(__file__).parent / "storage"


def argv(mode, marker, profile="allowed"):
    return ["etas", "run", str(PROJECT), "--profile", profile, "--allow-effects",
            "--args", mode, str(marker)]


def environment(db):
    return dict(os.environ, ETAS_HOST_MEMORY=f"sqlite:{db}")


def execute(db, mode, marker, profile="allowed", data=b""):
    return subprocess.run(argv(mode, marker, profile), env=environment(db), input=data,
                          capture_output=True, timeout=12)


def expect(result, text):
    assert result.returncode == 0, result.stderr
    assert result.stdout == text, result.stdout


def start(db, mode, marker):
    return subprocess.Popen(argv(mode, marker), env=environment(db), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)


def line(process, expected):
    assert select.select([process.stdout], [], [], 8)[0], "fixture readiness timeout"
    actual = process.stdout.readline()
    if actual != expected + b"\n":
        process.wait(timeout=3)
        raise AssertionError((expected, actual, process.stderr.read()))


def release(process):
    process.stdin.write(b"continue\n")
    process.stdin.flush()


def kill(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=3)
    for stream in [process.stdin, process.stdout, process.stderr]:
        stream.close()


def row(db):
    with sqlite3.connect(db) as connection:
        result = connection.execute("SELECT value_json,version FROM memory_entries").fetchone()
    return None if result is None else (json.loads(result[0]), result[1])


def pass_case(name):
    print(f"PASS {name}", flush=True)


def field(value, name):
    return next(item["value"] for item in value["fields"] if item["name"] == name)


def main():
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="arch001-s1-", dir=os.environ["CARGO_HOME"]) as temporary:
        root = Path(temporary)
        marker = root / "marker"
        db = root / "record.sqlite"
        expect(execute(db, "read", marker), b"ABSENT\n")
        expect(execute(db, "seed", marker), b"SEEDED\n")
        expect(execute(db, "read", marker), b"GEN_ONE\nsession-b\npending\nfixed-result\n")
        before = row(db)
        denied = execute(db, "seed", marker, "denied")
        assert denied.returncode != 0 and b"policy denied" in denied.stderr.lower(), denied
        assert row(db) == before and not marker.exists()
        pass_case("S1-01_nested_source_roundtrip_absence_denial")

        writers = [start(db, "cas", marker) for _ in range(2)]
        try:
            for writer in writers:
                line(writer, b"OBSERVED_ONE")
            release(writers[0])
            line(writers[0], b"WON")
            writers[0].wait(timeout=3)
            release(writers[1])
            line(writers[1], b"CONFLICT")
            writers[1].wait(timeout=3)
            assert all(writer.returncode == 0 for writer in writers)
            assert marker.read_bytes() == b"X"
            assert row(db)[1] == 2
            expect(execute(db, "read", marker), b"GEN_TWO\nsession-b\ncompleted\nfixed-result\n")
            expect(execute(db, "advance", marker), b"THREE\n")
            assert row(db)[1] == 3
            expect(execute(db, "read", marker), b"GEN_THREE\nsession-b\ncompleted\nfixed-result\n")
        finally:
            for writer in writers:
                kill(writer)
        pass_case("S1-03_two_readers_typed_conflict_generations_1_2_3")

        # These barriers are after synchronous Host acknowledgements, never timing guesses.
        for boundary, stops, expected_version, expected_marker in [
            ("before_intent", 0, None, b""), ("after_intent", 1, 1, b""),
            ("after_effect", 2, 1, b"X"), ("after_outcome", 3, 2, b"X"),
        ]:
            case_db = root / f"{boundary}.sqlite"
            effect = root / f"{boundary}.marker"
            writer = start(case_db, "writer", effect)
            try:
                line(writer, b"BEFORE_INTENT")
                for label in [b"INTENT", b"EFFECT", b"OUTCOME"][:stops]:
                    release(writer)
                    line(writer, label)
                # A separate CLI reader observes the acknowledged commit before writer exit.
                result = execute(case_db, "read", effect)
                assert result.returncode == 0, result.stderr
                current = row(case_db)
                assert (None if current is None else current[1]) == expected_version
                assert (effect.read_bytes() if effect.exists() else b"") == expected_marker
            finally:
                kill(writer)
            assert writer.returncode == -signal.SIGKILL
            recovered = execute(case_db, "read", effect)
            assert recovered.returncode == 0 and recovered.stdout == result.stdout, recovered
            assert (effect.read_bytes() if effect.exists() else b"") == expected_marker
            pass_case(f"S1-02_04_{boundary}_process_kill_no_reader_replay")

        # Lost acknowledgement: never consume the writer's INTENT response; observe commit via DB.
        lost = root / "lost.sqlite"
        effect = root / "lost.marker"
        writer = start(lost, "writer", effect)
        try:
            line(writer, b"BEFORE_INTENT")
            release(writer)
            deadline = time.monotonic() + 5
            while row(lost) is None:
                assert time.monotonic() < deadline
                time.sleep(0.01)
        finally:
            kill(writer)
        expect(execute(lost, "read", effect), b"GEN_ONE\nsession-b\npending\nfixed-result\n")
        assert not effect.exists()
        pass_case("S1-04_commit_visible_ack_unconsumed_pending")

        # Busy is a real SQLite writer lock, not an injected successful Host response.
        busy = root / "busy.sqlite"
        effect = root / "busy.marker"
        expect(execute(busy, "seed", effect), b"SEEDED\n")
        writer = start(busy, "cas", effect)
        try:
            line(writer, b"OBSERVED_ONE")
            with sqlite3.connect(busy) as lock:
                lock.execute("BEGIN IMMEDIATE")
                started = time.monotonic()
                release(writer)
                stdout, stderr = writer.communicate(timeout=10)
                elapsed = time.monotonic() - started
                assert writer.returncode != 0 and b"SQLite memory error" in stderr, (stdout, stderr)
                assert not effect.exists() and row(busy)[1] == 1
                lock.rollback()
        finally:
            kill(writer)
        print(f"OBS busy_elapsed_seconds={elapsed:.3f}")
        pass_case("S1-03_busy_refusal_no_marker")

        invalid = execute(busy, "bad-version", effect)
        assert invalid.returncode != 0 and not effect.exists() and row(busy)[1] == 1
        pass_case("S1-03_invalid_version_refusal")

        absent = root / "absent-existing.sqlite"
        result = execute(absent, "expected-existing", effect)
        assert result.returncode != 0 and not effect.exists() and row(absent) is None
        pass_case("S1-03_expected_existing_absence_refusal")

        overflow = root / "overflow.sqlite"
        expect(execute(overflow, "seed", effect), b"SEEDED\n")
        with sqlite3.connect(overflow) as connection:
            connection.execute("UPDATE memory_entries SET version = ?", (2**63 - 1,))
        before = row(overflow)
        result = execute(overflow, "overflow", effect)
        assert result.returncode != 0 and not effect.exists() and row(overflow) == before
        pass_case("S1-03_backend_version_overflow_refusal")

        # Tiny bounded failure injections; not a hostile-size decoding test.
        for name, diagnostic in [("workspace-schema", b"unsupported workspace schema"),
                                 ("session-schema", b"unsupported session schema"),
                                 ("generation", b"invalid generation")]:
            invalid_db = root / f"{name}.sqlite"
            expect(execute(invalid_db, "seed", effect), b"SEEDED\n")
            value, stored_version = row(invalid_db)
            if name == "workspace-schema":
                field(value, "schema")["value"] = "99"
            elif name == "session-schema":
                field(field(value, "sessions")["items"][1], "schema")["value"] = "99"
            else:
                field(value, "generation")["value"] = "0"
            with sqlite3.connect(invalid_db) as connection:
                connection.execute("UPDATE memory_entries SET value_json = ?", (json.dumps(value),))
            result = execute(invalid_db, "read", effect)
            assert result.returncode != 0 and diagnostic in result.stderr, result.stderr
            assert not effect.exists() and row(invalid_db) == (value, stored_version)
            pass_case(f"S1-03_05_{name}_refusal")

        corrupt = root / "corrupt.sqlite"
        corrupt.write_bytes(b"fixture-only invalid sqlite")
        result = execute(corrupt, "writer", root / "corrupt.marker", data=b"\n" * 4)
        assert result.returncode != 0 and not (root / "corrupt.marker").exists()
        pass_case("S1-05_corrupt_database_refusal")

        readonly = root / "readonly.sqlite"
        effect = root / "readonly.marker"
        expect(execute(readonly, "seed", effect), b"SEEDED\n")
        readonly.chmod(0o400)
        try:
            result = execute(readonly, "cas", effect, data=b"\n")
            assert result.returncode != 0 and not effect.exists() and row(readonly)[1] == 1
        finally:
            readonly.chmod(0o600)
        pass_case("S1-05_readonly_database_refusal")

        # Deliberate malformed persisted state, bounded to this tiny fixture database.
        malformed = root / "malformed.sqlite"
        expect(execute(malformed, "seed", marker), b"SEEDED\n")
        with sqlite3.connect(malformed) as connection:
            connection.execute("UPDATE memory_entries SET value_json = ?", ("{",))
        result = execute(malformed, "read", marker)
        assert result.returncode != 0 and b"GEN_" not in result.stdout
        pass_case("S1-05_09_malformed_newest_no_older_generation_fallback")

        secret = root / "seeded-secret.sqlite"
        sentinel = "ARCH001_FAKE_CREDENTIAL_DO_NOT_USE"
        result = execute(secret, "seed-secret", sentinel)
        assert result.returncode == 0, result.stderr
        with sqlite3.connect(secret) as connection:
            stored = connection.execute("SELECT value_json FROM memory_entries").fetchone()[0]
        assert sentinel in stored
        print("OBS S1-09 Memory persists caller text without redaction (public fake sentinel)")

        # A normal allowlisted command has the same filesystem visibility as its parent.
        access = root / "state-access.marker"
        result = subprocess.run(argv("inspect-state", access) + [str(db)], env=environment(db),
                                capture_output=True, timeout=10)
        assert result.returncode == 0 and access.read_bytes() == b"STATE_ACCESS", result.stderr
        print("OBS S1-08 configured command opened fixture database for read and write")

        # Inspect actual stored fixture, never seed or read a real credential.
        with sqlite3.connect(db) as connection:
            print("OBS journal_mode=" + connection.execute("PRAGMA journal_mode").fetchone()[0])
            print("OBS inspection_connection_synchronous=" + str(connection.execute("PRAGMA synchronous").fetchone()[0]))
            print("OBS sqlite_integrity=" + connection.execute("PRAGMA integrity_check").fetchone()[0])
        print(f"OBS state_dir_mode={oct(root.stat().st_mode & 0o777)} db_mode={oct(db.stat().st_mode & 0o777)}")
        print("NOT_PROVEN S1-05 full/size/headroom/preallocation limits")
        print("NOT_PROVEN S1-06 lifetime execution ownership; CAS is not exclusion")
        print("NOT_PROVEN S1-07 source-accessible durable root identity")
        print("NOT_PROVEN S1-08 command-inaccessible persistent state boundary")
        print("NOT_PROVEN S1-09 safe latest selection/redaction/budget reconciliation")
        print("NOT_PROVEN S1-10 source-level stop/drain/finalization/input ownership")


if __name__ == "__main__":
    main()
