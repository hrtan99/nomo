module app.main;

import std.io.println;
import std.json.parse;
import std.agent.message.Message;
import nomo.domain.serialization.json.encode;
import nomo.domain.execution.command.{CommandRequest, CommandOutput, CommandMode};
import nomo.application.commands.ports.{CommandRunner, CommandPreviewSink};
import nomo.application.commands.service.{run as command_run, step as command_step};
import nomo.application.conversation.session_context.SessionContext;
import nomo.adapters.storage.conversations.{NativeHistory, pending_request, tool_finished};
import nomo.adapters.storage.attempts.NativeAttempts;
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, ConversationCatalog, ResultPublication};
import nomo.application.execution.service.returned as publish_return;
import nomo.bootstrap.execution.{attempts, begin, dispatching, returned, resolve};

type Result = { status: string };
type InterruptedPublication = {};
type RecordedCommand = {};
type QuietPreview = {};

impl RecordedCommand ~ CommandRunner {
    flow run(self, request: CommandRequest) -> CommandOutput {
        let text = match encode(request, "request capture failed", "request capture encoding failed") {
            Ok(value) => value, Err(error) => { abort(error); }
        };
        return CommandOutput { exit_code = 0, stdout = text, stderr = "" };
    }
}

impl QuietPreview ~ CommandPreviewSink { flow show(self, request: CommandRequest) -> unit {} }

impl InterruptedPublication ~ ResultPublication {
    flow prepare_result(self, id: string, role: string, name: string, call: i64) -> i64 { return (NativeHistory {}).prepare_result(id, role, name, call); }
    flow publish_result(self, id: string, index: i64, text: string) -> unit { abort("fixture interrupted before result archive completion"); }
    flow result_complete(self, id: string, index: i64) -> bool { return (NativeHistory {}).result_complete(id, index); }
    flow select_summary(self, id: string, index: i64, through: i64) -> unit { (NativeHistory {}).select_summary(id, index, through); }
    flow finish_command(self, id: string, call: i64) -> unit { (NativeHistory {}).finish_command(id, call); }
    flow acknowledge(self, id: string, call: i64, note: string) -> i64 { return (NativeHistory {}).acknowledge(id, call, note); }
}

flow main(args: Array<string>) -> i32 ![Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
    let archive = NativeHistory {};
    if args[0] == "command-port" {
        let saved = archive.create("command-port", "Synthetic command port; no shell execution");
        let request = CommandRequest { program = "synthetic-no-shell", arguments = ["literal a", "café"], stdin = Some("stdin café\n") };
        let observed = command_run(RecordedCommand {}, QuietPreview {}, NativeAttempts {}, archive, archive, archive,
            saved.id, CommandMode.Mutating, request);
        let json = match parse(observed.output.stdout) { Ok(value) => value, Err(_) => { abort("recorded command is not JSON"); } };
        let value: Option<Message<CommandRequest>> = Message.new(json).cast<CommandRequest>();
        let recorded = match value { Some(value) => value.body, None() => { abort("recorded command shape changed"); } };
        if recorded.program != "synthetic-no-shell" || recorded.arguments.len() != 2 || recorded.arguments[0] != "literal a" || recorded.arguments[1] != "café" {
            abort("command port changed program or argv");
        }
        match recorded.stdin { Some(value) => { if value != "stdin café\n" { abort("command port changed stdin"); } } None() => { abort("command stdin lost"); } }
        if archive.load(saved.id).pending != "" || attempts(saved.id, false).len() != 1 { abort("command sequencing did not complete"); }
        let parent = archive.append(saved.id, "tool_call", "fixture_journal", "{}", -1);
        let pending = archive.load(saved.id).pending;
        command_step(RecordedCommand {}, QuietPreview {}, archive, saved.id,
            CommandRequest { program = "synthetic-step", arguments = [], stdin = None() }, parent);
        if archive.load(saved.id).pending != pending || attempts(saved.id, false).len() != 1 { abort("subordinate step replaced its parent"); }
        command_run(RecordedCommand {}, QuietPreview {}, NativeAttempts {}, archive, archive, archive, saved.id,
            CommandMode.Observation("fixture_readonly"), CommandRequest { program = "synthetic-observation", arguments = [], stdin = None() });
        if archive.load(saved.id).pending != pending || attempts(saved.id, false).len() != 2 { abort("observation replaced its parent"); }
        handle { tool_finished("fixture_journal", parent, Result { status = "synthetic complete" }); }
            with { SessionContext.current() => { resume saved.id; } };
        println("COMMAND PORT recorded exact argv/stdin; parent retained; no shell execution");
        return 0;
    }
    if args[0] == "seed-incomplete" {
        let saved = archive.create("receipt-incomplete", "Incomplete result archive");
        let attempt = begin(saved.id, "coding", "synthetic incomplete result; no Host execution", -1, -1);
        dispatching(attempt.id);
        publish_return(NativeAttempts {}, InterruptedPublication {}, attempt.id, "assistant", "", "synthetic result not fully archived", -1);
        abort("interrupted publication unexpectedly returned");
    }
    if args[0] == "settle-incomplete" {
        let id = match archive.selected("receipt-incomplete") { Some(value) => value, None() => { abort("incomplete receipt missing"); } };
        let outstanding = attempts(id, true);
        if outstanding.len() != 1 || outstanding[0].phase != "returned" || outstanding[0].result_event < 0 {
            abort("interrupted result lost its returned phase or reserved slot");
        }
        let before = archive.load(id);
        let index = outstanding[0].result_event;
        if archive.result_complete(id, index) || archive.message(id, index).name != "archive_interrupted" {
            abort("incomplete result was presented as complete");
        }
        let closed = resolve(id, outstanding[0].id, "Inspected the partial archive; the result remains unknown.");
        if closed.phase != "closed_unknown" || closed.result_event != index || closed.recovery_event < 0 {
            abort("incomplete result was not retained as unknown");
        }
        if archive.load(id).next_event != before.next_event + 1 || archive.result_complete(id, index)
            || archive.message(id, index).name != "archive_interrupted" {
            abort("unknown-result closure rewrote or replayed the result");
        }
        println("INCOMPLETE reserved result retained as unknown; no publication replay");
        return 0;
    }
    if args[0] == "seed" {
        let selected = archive.create("synthetic", "Recorded receipt");
        let call = archive.append(selected.id, "tool_call", "fixture_command", "{}", -1);
        archive.append(selected.id, "tool", "fixture_command", "{\"status\":\"complete\"}", call);
        if archive.load(selected.id).pending == "" { abort("fixture must retain the unfinished pending slot"); }
        @limits([Iterations(3)]) for kind in ["coding", "summary", "command"]   {
            let saved = archive.create("receipt-" + kind, "Metadata receipt only");
            let call = if kind == "command" { archive.append(saved.id, "tool_call", "command", "{}", -1) } else { -1 };
            let attempt = begin(saved.id, kind, "synthetic metadata fixture; no Host execution", call, -1);
            dispatching(attempt.id);
            let role = match kind { "command" => "tool", "summary" => "summary", _ => "assistant" };
            let name = match kind { "command" => "command", "summary" => "context_summary", _ => "" };
            returned(attempt.id, role, name, "synthetic saved result", call);
            // End the process with the actual saved-result slot, before its
            // metadata/summary/pending completion steps.
        }
        println("SEED result persisted before pending cleanup");
        return 0;
    }
    let id = match archive.selected("synthetic") { Some(value) => value, None() => { abort("receipt session missing"); } };
    let before = archive.load(id);
    let pending = match pending_request(id) { Some(value) => value, None() => { abort("pending receipt missing"); } };
    handle { tool_finished(pending.name, pending.call, Result { status = "complete" }); }
        with { SessionContext.current() => { resume id; } };
    let after = archive.load(id);
    if after.pending != "" || after.next_event != before.next_event || after.next_event != 2 { abort("receipt was duplicated or not settled"); }
    let rows = archive.messages(id, 0);
    if rows[1].text != "{\"status\":\"complete\"}" { abort("original result changed"); }
    @limits([Iterations(3)]) for kind in ["coding", "summary", "command"]   {
        let saved = match archive.selected("receipt-" + kind) { Some(value) => value, None() => { abort("lifecycle receipt missing"); } };
        let before = archive.load(saved);
        let outstanding = attempts(saved, true);
        if outstanding.len() != 1 { abort("expected one returned receipt"); }
        let completed = resolve(saved, outstanding[0].id, "");
        let after = archive.load(saved);
        if completed.phase != "completed" || after.next_event != before.next_event || after.pending != "" {
            abort("lifecycle completion duplicated events or retained pending");
        }
        if archive.messages(saved, completed.result_event)[0].text != "synthetic saved result" { abort("saved result was replaced"); }
        if kind == "summary" && after.summary_event != completed.result_event { abort("saved summary was not adopted"); }
    }
    println("SETTLED original result retained; no duplicate event");
    return 0;
}
