module nomo.adapters.cli.console;

import nomo.domain.harness.read.TextStage;
import nomo.domain.conversation.{TraceRole, TraceKind};
import nomo.domain.changes.{wire_journal, wire_change_outcome};
import std.json.JsonValue;
import nomo.domain.archives.wire_copy;
import nomo.domain.processes.ProcessWire;
import nomo.domain.attempts.wire_attempt;
import nomo.adapters.cli.input.command;
import nomo.adapters.codec.json as codec_json;
import nomo.application.conversation.ports.{ConversationOutputSink, ConversationPicker, TerminalDisplay, TerminalEvent, TerminalInput};
import nomo.application.editing.ports.{MutationOutputSink, WorkOutputSink};
import nomo.application.execution.commands.preview_text;
import nomo.application.execution.ports.{CommandPreviewSink, ProcessPreviewSink};
import nomo.application.harness.ports.{ConsoleEventSink, ConsoleProgressWriter, ConversationSink, DiagnosticSink, ProgressSink};
import nomo.application.harness.work.{expanded_ledger_text, historical_ledger_text};
import nomo.application.transfer.ports.TransferRenderer;
import nomo.application.workspace.ports.ProjectRenderer;
import nomo.domain.archives.ExportPreview;
import nomo.domain.commands.{Command as commands_Command, CommandRequest};
import nomo.domain.conversation.{TraceEvent, SavedSession};
import nomo.domain.editing.Selector;
import nomo.domain.harness.loop.ReadLedger;
import nomo.domain.harness.read.Ledger;
import nomo.domain.harness.work.WorkLedger;
import nomo.domain.wire.{encode, json as wire_json};
import std.io.{IOError, print, println, read_line};
import std.text.{from_i32, from_i64, from_usize, parse_usize, trim};

public type ConsoleCommandPreview = {};

impl ConsoleCommandPreview ~ CommandPreviewSink {
    flow show(self, request: CommandRequest) -> unit ![Console, Error<IOError>] {
        println("[COMMAND] " + preview_text(request));
    }
}

public type ConsoleTerminalInput = {};

impl ConsoleTerminalInput ~ TerminalInput {
    flow next(self) -> Option<commands_Command> ![Console, Error<IOError>] {
        println("nomo> ");
        let raw = read_line();
        return if raw == "" {
            None()
        } else {
            Some(command(trim(raw)))
        };
    }
}

flow json<T>(tag: string, value: T, conversion: string, encoding: string) -> unit {
    let text = match encode(value, conversion, encoding) {
        Ok(value) => value,
        Err(error) => abort(error),
    };
    println(tag + text);
}

public type ConsoleTerminalDisplay = {};

impl ConsoleTerminalDisplay ~ TerminalDisplay {
    flow show(self, event: TerminalEvent) -> unit ![Console, Error<IOError>] {
        match event {
            TerminalEvent.Message(line) => println(line),
            TerminalEvent.Help => {
                println("Projects: /projects, /open [FOLDER_OR_NUMBER]. Project selection is native; the launcher attaches that folder's execution endpoint and keeps the current endpoint running.");
                println("Git: /git status, diff [--staged] [JSON_PATHS], log [COUNT], branches, init, branch NAME, switch NAME, commit JSON. Commit JSON contains message and paths.");
                println("Ask about the project; native tools provide recursive/glob discovery, literal/regex search, file reads, approved editing and Git operations.");
                println("Terminal: /exec JSON_ARGV, /spawn JSON_ARGV, /jobs, /poll JOB [MAX_BYTES], /send JOB JSON_STRING, /close-input JOB, /stop JOB, /job-output JOB. /jobs also lists migrated workspace jobs with [OLD JOB]; /archived-output JOB [PART] reads their retained raw output and next_part. /poll waits for output or termination. Saved job phases are historical observations; current Host handles are not durable across process restart.");
                println("/new [TITLE], /sessions [all], /resume [ID], /rename TITLE, /history [TEXT], /page EVENT, /fork [EVENT], /export FILE, /import FILE, /copies, /resume-copy ID, /discard-copy ID, /runs, /resolve-run ID [NOTE], /config, /check, /compact, /status, /tree [PATH], /glob PATTERN, /search REGEX, /read FILE, /edits, /undo [EDIT], /rollback EDIT, /recover EDIT, /quit");
            },
            TerminalEvent.Welcome => println("[NATIVE ] Nomo native chat · /help · /quit"),
            TerminalEvent.Project(path) => println(
                "[PROJECT] "
                    + path
            ),
            TerminalEvent.SessionHeader(value) => println(
                "[SESSION] " + value.id + " · "
                    + value.title
            ),
            TerminalEvent.CopyState(job) => println(
                "[COPY   ] " + job.phase.wire() + "; /resume-copy " + job.id
                    + " or /discard-copy " + job.id
            ),
            TerminalEvent.Pending(value) => println(
                "[PENDING] " + value
                    + " has no recorded completion. Inspect actual state; it is not automatically replayed."
            ),
            TerminalEvent.UnresolvedAttempt(attempt) => println(
                "[RUN    ] " + attempt.id + " " + attempt.kind.wire()
                    + " " + attempt.phase.wire()
                    + "; no completion recorded. Inspect actual state, then /resolve-run ID [NOTE]."
            ),
            TerminalEvent.History(item) => println(
                "[" + item.role + "/" + item.name + " #" + item.id + "] "
                    + item.text
            ),
            TerminalEvent.MoreHistory(index) => println(
                "[HISTORY] More events remain; /page "
                    + from_i64(index)
            ),
            TerminalEvent.Status(value) => {
                json("[STATUS ] ", value, "status conversion failed", "status encoding failed");
                println("[BUDGET ] generation_allowance is configured allowance; context_bytes is an estimate, not measured token usage.");
            },
            TerminalEvent.Git(value) => json(
                "[GIT    ] ",
                value,
                "process conversion failed",
                "process encoding failed"
            ),
            TerminalEvent.CommandResult(value) => json(
                "[JOB    ] ",
                value,
                "process conversion failed",
                "process encoding failed"
            ),
            TerminalEvent.ProcessJob(value) => json(
                "[JOB    ] ",
                value.wire(),
                "process conversion failed",
                "process encoding failed"
            ),
            TerminalEvent.JobRead(value) => json(
                "[JOB    ] ",
                value.wire(),
                "process conversion failed",
                "process encoding failed"
            ),
            TerminalEvent.JobInput(value) => json(
                "[JOB    ] ",
                value.wire(),
                "process conversion failed",
                "process encoding failed"
            ),
            TerminalEvent.JobOutput(value) => json(
                "[JOB    ] ",
                JsonValue.Array(value.iter().map(item => item.wire()).collect()),
                "process conversion failed",
                "process encoding failed"
            ),
            TerminalEvent.ArchivedProcessJob(value) => json(
                "[OLD JOB] ",
                value.wire(),
                "archived job conversion failed",
                "archived job encoding failed"
            ),
            TerminalEvent.ArchivedOutput(value) => json(
                "[OLD OUT] ",
                value,
                "archived output conversion failed",
                "archived output encoding failed"
            ),
            TerminalEvent.Discovery(value) => {
                println(value.stdout);
                if value.stderr != "" {
                    println(value.stderr);
                }
                if value.exit_code > 1 {
                    println("[ERROR  ] Project discovery exited " + from_i32(value.exit_code));
                }
            },
            TerminalEvent.File(value) => json(
                "[FILE   ] ",
                value,
                "file conversion failed",
                "file encoding failed"
            ),
            TerminalEvent.Edit(value) => json(
                "[EDIT   ] ",
                wire_journal(value),
                "edit conversion failed",
                "edit encoding failed"
            ),
            TerminalEvent.EditResult(value) => json(
                "[EDIT   ] ",
                wire_change_outcome(value),
                "edit result conversion failed",
                "edit result encoding failed"
            ),
            TerminalEvent.Copy(value) => json(
                "[COPY   ] ",
                wire_copy(value),
                "copy conversion failed",
                "copy encoding failed"
            ),
            TerminalEvent.UnfinishedCopy(job) => println(
                "[COPY   ] Unfinished " + job.kind.wire() + " " + job.id
                    + "; /resume-copy " + job.id + " or /discard-copy "
                    + job.id
            ),
            TerminalEvent.Run(value) => json(
                "[RUN    ] ",
                wire_attempt(value),
                "run conversion failed",
                "run encoding failed"
            ),
            TerminalEvent.Resolved(value) => println(
                "[RUN    ] " + value.id + " " + value.phase.wire()
                    + "; prior operations were not replayed."
            ),
            TerminalEvent.Config(value) => json(
                "[CONFIG ] ",
                value,
                "configuration conversion failed",
                "configuration encoding failed"
            ),
            TerminalEvent.Check(value) => json(
                "[CHECK  ] ",
                value,
                "check conversion failed",
                "check encoding failed"
            ),
        }
    }
}

public type ConsoleConversationPicker = {};

impl ConsoleConversationPicker ~ ConversationPicker {
    flow choose(self, sessions: Array<SavedSession>) -> Option<string> ![Console, Error<IOError>] {
        for (index, item) in sessions.iter().enumerate() {
            println("[SESSION] " + from_usize(index + 1) + " · " + item.id + " · " + item.title);
            println("          " + item.workspace);
        }
        print("Conversation number or ID (empty cancels): ");
        let selected = trim(read_line());
        if selected == "" {
            return None();
        }
        match parse_usize(selected) {
            Ok(index) => {
                if index > 0 {
                    match sessions.get(index - 1) {
                        Some(item) => {
                            return Some(item.id);
                        }
                        None() => (),
                    }
                }
                abort("conversation number is not in the displayed list");
            }
            Err(_) => {
                return Some(selected);
            }
        }
    }
}

public type ConsoleDiagnostics = {};

impl ConsoleDiagnostics ~ DiagnosticSink {
    flow write(self, line: string) -> unit ![Error<IOError>] {
        println(line);
    }
}

public type PublicChildEvents = {};

public type RedactedChildEvents = {};

public type PublicHarnessEvents = {};

public type RedactedHarnessEvents = {};

flow harness(event: TraceEvent, text: string) -> unit ![Error<IOError>] {
    println("EVENT " + event.role.wire() + " " + event.kind.wire() + " " + event.name + ": " + text);
}

impl PublicChildEvents ~ ConversationSink {
    flow publish(self, event: TraceEvent) -> unit ![Error<IOError>] {
        publish(event);
    }
}

impl RedactedChildEvents ~ ConversationSink {
    flow publish(self, event: TraceEvent) -> unit ![Error<IOError>] {
        println(
            "CHILD EVENT " + event.role.wire() + " " + event.kind.wire() + " " + event.name
                + ": [REDACTED]"
        );
    }
}

impl PublicHarnessEvents ~ ConversationSink {
    flow publish(self, event: TraceEvent) -> unit ![Error<IOError>] {
        harness(event, event.text);
    }
}

impl RedactedHarnessEvents ~ ConversationSink {
    flow publish(self, event: TraceEvent) -> unit ![Error<IOError>] {
        harness(event, "[REDACTED]");
    }
}

public flow publish(event: TraceEvent) -> unit ![Error<IOError>] ~ ConsoleEventSink {
    let role = event.role;
    let kind = event.kind;
    let name = event.name;
    let text = event.text;
    if kind == TraceKind.Error {
        println("error: " + text);
    }
    else if role == TraceRole.Model {
        println(if kind == TraceKind.Text {
            "model: text " + name
        } else {
            "model: tool " + name
        });
    }
    else if role == TraceRole.Tool {
        println("tool: " + name + ": " + text);
    }
    else {
        println(role.wire() + ": " + text);
    }
}

public flow write(line: string) -> unit ![Error<IOError>] ~ ConsoleProgressWriter {
    println(line);
}

public type ConsoleProgress = {};

public type SilentProgress = {};

impl ConsoleProgress ~ ProgressSink {
    flow write(self, line: string) -> unit ![Error<IOError>] {
        println(line);
    }
}

impl SilentProgress ~ ProgressSink {
    flow write(self, line: string) -> unit ![Error<IOError>] {
        return;
    }
}

public flow recorded(selector: Selector) -> unit {
    println(
        "EDIT completed " + selector.id
            + "; aggregation cannot change the recorded outcome; do not replay."
    );
    match wire_json(
        ["edit_status", "--id", selector.id, "--workspace", selector.workspace, "--path", selector.path]
    ) {
        Ok(value) => println(
            "NEXT "
                + value
        ),
        Err(_) => println("Recorded operation is available through edit_status with the same selectors."),
    }
}

public flow display(prefix: string, text: string) -> unit {
    match wire_json([text]) {
        Ok(value) => println(
            prefix
                + value
        ),
        Err(error) => abort(error),
    }
}

public flow ledger(state: WorkLedger) -> unit {
    println(
        historical_ledger_text(state)
            + "; configured allowances are not measured usage; no persisted Model history or mutating resume"
    );
}

public flow simple_refused(error: string) -> i32 {
    println("REFUSED " + error);
    return 1;
}

public flow expanded_ledger(state: WorkLedger, wide: bool) -> unit {
    println(expanded_ledger_text(state, wide, false));
}

public flow expanded_ledger_mode(state: WorkLedger, wide: bool, high_input: bool) -> unit {
    println(expanded_ledger_text(state, wide, high_input));
}

public type TerminalWorkOutput = {};

impl TerminalWorkOutput ~ WorkOutputSink {
    flow progress(self, line: string) -> unit ![Error<IOError>] {
        println(line);
    }

    flow diagnostic(self, line: string) -> unit ![Error<IOError>] {
        println(line);
    }

    flow recorded(self, selected: Selector) -> unit ![Error<IOError>, Error<IndexError>] {
        recorded(selected);
    }

    flow ledger(self, state: WorkLedger, wide: bool, high_input: bool) -> unit ![Error<IOError>] {
        expanded_ledger_mode(state, wide, high_input);
    }

    flow refused(self, error: string) -> i32 ![Error<IOError>] {
        return simple_refused(error);
    }

    flow completed(self, answer: string, saved: string, state: WorkLedger, wide: bool, high_input: bool) -> i32 ![
        Error<IOError>,
        Error<IndexError>
    ] {
        display("FINAL ", answer);
        println(saved);
        expanded_ledger_mode(state, wide, high_input);
        return 0;
    }
}

public type ConsoleLines = {};

impl ConsoleLines ~ ConversationOutputSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] {
        println(line);
    }
}

impl ConsoleLines ~ MutationOutputSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] {
        println(line);
    }
}

impl ConsoleLines ~ ProcessPreviewSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] {
        println(line);
    }
}

public type TerminalProjects = {};

impl TerminalProjects ~ ProjectRenderer {
    flow item(self, index: usize, path: string) -> unit ![Console, Error<IOError>] {
        println("[PROJECT] " + from_usize(index) + " " + path);
    }

    flow choose(self) -> string ![Console, Error<IOError>] {
        print("project> folder path or saved number (blank cancels): ");
        return read_line();
    }

    flow preview(self, path: string) -> unit ![Console, Error<IOError>] {
        let value = match encode(path, "project path conversion failed", "project path encoding failed") {
            Ok(value) => value,
            Err(error) => abort(error),
        };
        println("[OPEN   ] " + value);
    }
}

public type TerminalTransfer = {};

impl TerminalTransfer ~ TransferRenderer {
    flow progress(self, id: string, copied: i64, total: i64) -> unit ![Console, Error<IOError>] {
        println("[COPY   ] " + id + " " + from_i64(copied) + "/" + from_i64(total));
    }

    flow preview(self, value: ExportPreview) -> unit ![Console, Error<IOError>] {
        println("[EXPORT ] " + codec_json(value));
    }

    flow exported(self, path: string) -> unit ![Console, Error<IOError>] {
        println("[EXPORTED] " + path);
    }
}

flow numbers(state: Ledger) -> string {
    return "steps=" + from_i32(state.steps) + " calls=" + from_i32(state.calls) + " tokens="
        + from_i32(state.tokens);
}

public flow precharged(phase: TextStage, state: Ledger) -> unit {
    println(
        "STAGE " + phase.wire() + " child-1 " + numbers(state) + " reserved_steps="
            + from_i32(5 - state.steps)
            + " reserved_calls=" + from_i32(3 - state.calls) + " reserved_tokens="
            + from_i32(6144 - state.tokens)
    );
}

public flow settled(state: Ledger) -> unit {
    println(
        "LEDGER steps=" + from_i32(state.steps) + "/5 calls=" + from_i32(state.calls) + "/3 tokens="
            + from_i32(state.tokens) + "/6144 reserved_steps=0 reserved_calls=0 reserved_tokens=0"
    );
}

public flow text_delegation_refused(state: Ledger, error: string) -> i32 {
    println("REFUSED " + error);
    settled(state);
    return 1;
}

public flow ascii_read_finished(state: ReadLedger) -> unit {
    println(
        "LEDGER steps=" + from_i32(state.steps) + "/7 calls=" + from_i32(state.calls) + "/4 tokens="
            + from_i32(state.tokens) + "/8192 tools=" + from_i32(state.tools) + "/1 scan="
            + from_i32(state.scan)
            + "/4096 reserved_steps=0 reserved_calls=0 reserved_tokens=0 reserved_tools=0 reserved_scan=0"
    );
}

public flow ascii_read_refused(state: ReadLedger, error: string) -> i32 {
    println("REFUSED " + error);
    ascii_read_finished(state);
    return 1;
}

public flow unicode_read_finished(state: ReadLedger) -> unit {
    println(
        "LEDGER steps=" + from_i32(state.steps) + "/7 calls=" + from_i32(state.calls) + "/4 tokens="
            + from_i32(state.tokens) + "/8192 tools=" + from_i32(state.tools) + "/1 scan="
            + from_i32(state.scan)
            + "/16384 reserved_steps=0 reserved_calls=0 reserved_tokens=0 reserved_tools=0 reserved_scan=0"
    );
}

public flow unicode_read_refused(state: ReadLedger, error: string) -> i32 {
    println("REFUSED " + error);
    unicode_read_finished(state);
    return 1;
}

public flow unresolved(error: string) -> i32 {
    println("REFUSED " + error);
    println("RESERVATION child-1 unresolved=true; returned child metadata refused");
    return 1;
}
