module app.main;

import std.io.println;
import nomo.native.history.SessionContext;
import nomo.adapters.etas.conversations.{NativeHistory, pending_request, tool_finished};
import nomo.adapters.etas.attempts.NativeAttempts;
import nomo.application.native.conversation.ports.{ConversationReader, ConversationWriter, ConversationCatalog, ResultPublication};
import nomo.application.native.execution.service.returned as publish_return;
import nomo.bootstrap.execution.{attempts, begin, dispatching, returned, resolve};

type Result = { status: string };
type InterruptedPublication = {};

impl InterruptedPublication ~ ResultPublication {
    flow prepare_result(self, id: string, role: string, name: string, call: i64) -> i64 { return (NativeHistory {}).prepare_result(id, role, name, call); }
    flow publish_result(self, id: string, index: i64, text: string) -> unit { abort("fixture interrupted before result archive completion"); }
    flow result_complete(self, id: string, index: i64) -> bool { return (NativeHistory {}).result_complete(id, index); }
    flow select_summary(self, id: string, index: i64, through: i64) -> unit { (NativeHistory {}).select_summary(id, index, through); }
    flow finish_command(self, id: string, call: i64) -> unit { (NativeHistory {}).finish_command(id, call); }
    flow acknowledge(self, id: string, call: i64, note: string) -> i64 { return (NativeHistory {}).acknowledge(id, call, note); }
}

flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
    let archive = NativeHistory {};
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
        for kind in ["coding", "summary", "command"] limit Iterations(3) {
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
    for kind in ["coding", "summary", "command"] limit Iterations(3) {
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
