module nomo.adapters.cli.conversation;

import std.io.{println, read_line, IOError};
import std.text.{trim, from_i64, from_i32};
import nomo.domain.serialization.json.encode;
import nomo.domain.conversation.commands.Command;
import nomo.adapters.cli.native.commands.command;
import nomo.application.conversation.terminal_ports.{TerminalInput, TerminalDisplay, TerminalEvent};

public type ConsoleTerminalInput = {};
impl ConsoleTerminalInput ~ TerminalInput {
    flow next(self) -> Option<Command> ![Console, Error<IOError>] {
        println("nomo> ");
        let raw = read_line();
        return if raw == "" { None() } else { Some(command(trim(raw))) };
    }
}

flow json<T>(tag: string, value: T, conversion: string, encoding: string) -> unit {
    let text = match encode(value, conversion, encoding) { Ok(value) => value, Err(error) => abort(error), };
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
                    println("Terminal: /exec JSON_ARGV, /spawn JSON_ARGV, /jobs, /poll JOB [MAX_BYTES], /send JOB JSON_STRING, /close-input JOB, /stop JOB, /job-output JOB. /poll waits for output or termination. Saved job phases are historical observations; current Host handles are not durable across process restart.");
                    println("/new [TITLE], /sessions [all], /resume [ID], /rename TITLE, /history [TEXT], /page EVENT, /fork [EVENT], /export FILE, /import FILE, /copies, /resume-copy ID, /discard-copy ID, /runs, /resolve-run ID [NOTE], /config, /check, /compact, /status, /tree [PATH], /glob PATTERN, /search REGEX, /read FILE, /edits, /undo [EDIT], /rollback EDIT, /recover EDIT, /quit");
            },
            TerminalEvent.Welcome => println("[NATIVE ] Nomo native chat · /help · /quit"),
            TerminalEvent.Project(path) => println("[PROJECT] " + path),
            TerminalEvent.SessionHeader(value) => println("[SESSION] " + value.id + " · " + value.title),
            TerminalEvent.CopyState(job) => println("[COPY   ] " + job.phase + "; /resume-copy " + job.id + " or /discard-copy " + job.id),
            TerminalEvent.Pending(value) => println("[PENDING] " + value + " has no recorded completion. Inspect actual state; it is not automatically replayed."),
            TerminalEvent.UnresolvedAttempt(attempt) => println("[RUN    ] " + attempt.id + " " + attempt.kind + " " + attempt.phase + "; no completion recorded. Inspect actual state, then /resolve-run ID [NOTE]."),
            TerminalEvent.History(item) => println("[" + item.role + "/" + item.name + " #" + item.id + "] " + item.text),
            TerminalEvent.MoreHistory(index) => println("[HISTORY] More events remain; /page " + from_i64(index)),
            TerminalEvent.Status(value) => {
                json("[STATUS ] ", value, "status conversion failed", "status encoding failed");
                println("[BUDGET ] generation_allowance is configured allowance; context_bytes is an estimate, not measured token usage.");
            },
            TerminalEvent.Git(value) => json("[GIT    ] ", value, "process conversion failed", "process encoding failed"),
            TerminalEvent.CommandResult(value) => json("[JOB    ] ", value, "process conversion failed", "process encoding failed"),
            TerminalEvent.ProcessJob(value) => json("[JOB    ] ", value, "process conversion failed", "process encoding failed"),
            TerminalEvent.JobRead(value) => json("[JOB    ] ", value, "process conversion failed", "process encoding failed"),
            TerminalEvent.JobInput(value) => json("[JOB    ] ", value, "process conversion failed", "process encoding failed"),
            TerminalEvent.JobOutput(value) => json("[JOB    ] ", value, "process conversion failed", "process encoding failed"),
            TerminalEvent.Discovery(value) => {
                println(value.stdout);
                if value.stderr != "" { println(value.stderr); }
                if value.exit_code > 1 { println("[ERROR  ] Project discovery exited " + from_i32(value.exit_code)); }
            },
            TerminalEvent.File(value) => json("[FILE   ] ", value, "file conversion failed", "file encoding failed"),
            TerminalEvent.Edit(value) => json("[EDIT   ] ", value, "edit conversion failed", "edit encoding failed"),
            TerminalEvent.EditResult(value) => json("[EDIT   ] ", value, "edit result conversion failed", "edit result encoding failed"),
            TerminalEvent.Copy(value) => json("[COPY   ] ", value, "copy conversion failed", "copy encoding failed"),
            TerminalEvent.UnfinishedCopy(job) => println("[COPY   ] Unfinished " + job.kind + " " + job.id + "; /resume-copy " + job.id + " or /discard-copy " + job.id),
            TerminalEvent.Run(value) => json("[RUN    ] ", value, "run conversion failed", "run encoding failed"),
            TerminalEvent.Resolved(value) => println("[RUN    ] " + value.id + " " + value.phase + "; prior operations were not replayed."),
            TerminalEvent.Config(value) => json("[CONFIG ] ", value, "configuration conversion failed", "configuration encoding failed"),
            TerminalEvent.Check(value) => json("[CHECK  ] ", value, "check conversion failed", "check encoding failed"),
        }
    }
}
