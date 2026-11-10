module app.main;

import std.io.println;
import nomo.native.history.{NativeHistory, ConversationStore, SessionContext, pending_request, tool_finished};
import nomo.native.lifecycle.{attempts, begin, dispatching, returned, resolve};

type Result = { status: string };

flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
    let archive = NativeHistory {};
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
