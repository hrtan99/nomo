module app.main;

import std.io.println;
import nomo.native.history.{NativeHistory, ConversationStore, SessionContext, pending_request, tool_finished};

type Result = { status: string };

flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
    let archive = NativeHistory {};
    if args[0] == "seed" {
        let selected = archive.create("synthetic", "Recorded receipt");
        let call = archive.append(selected.id, "tool_call", "fixture_command", "{}", -1);
        archive.append(selected.id, "tool", "fixture_command", "{\"status\":\"complete\"}", call);
        if archive.load(selected.id).pending == "" { abort("fixture must retain the unfinished pending slot"); }
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
    println("SETTLED original result retained; no duplicate event");
    return 0;
}
