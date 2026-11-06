module app.recoverable_work_probe;

import std.io.println;
import nomo.core.conversation.Event;
import nomo.session.redaction.Policy;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_edit_contract.Ledger as EditLedger;
import nomo.harness.harness_work_contract.Ledger as WorkLedger;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult};
import nomo.session.recoverable_chat_store.{create as create_chat, load as load_chat, reserve as reserve_chat, finish as finish_chat};
import nomo.session.recoverable_work_store.{admit, claim, finish, load};
import nomo.session.event_text_codec.decode;
import std.text.{len as byte_len, starts_with};

flow chat_result(maximum: ReadLedger) -> TurnResult {
    let prior = Previous { task = "Read context", result = "blue", tool = "read", outcome = "complete: blue", answer = "blue" };
    let used = ReadLedger { steps = 7, calls = 4, tokens = 270336, tools = 1, scan = 4194560 };
    let state = Invocation { usage = used, maximum = maximum, admitted = 1, prior = prior };
    let records = [Event { role = "user", kind = "request", name = "", text = "First question" },
        Event { role = "tool", kind = "result", name = "read", text = "complete: blue" }];
    let done = Completed { request = "First question", task = prior.task, result = prior.result, tool = prior.tool,
        outcome = prior.outcome, answer = prior.answer, records = records };
    return TurnResult { status = 0, state = state, resolved = true, completed = Some(done) };
}
flow spent() -> WorkLedger {
    return WorkLedger { read = ReadLedger { steps = 7, calls = 4, tokens = 143360, tools = 1, scan = 1048580 },
        edit = EditLedger { steps = 6, calls = 3, tokens = 143360, native_tokens = 163840, boundaries = 3 } };
}
flow large_event() -> string {
    var block = "0123456789abcdef"; var index: i32 = 0;
    while index < 14 limit Iterations(14) { block = block + block; index = index + 1; }
    return "complete: blue\nVERY_SECRET_123\n" + block;
}

public flow recoverable_work_probe(args: Array<string>) -> i32 ![Console, Memory, Error<IOError>, Error<StorageError>, Error<IndexError>] {
    let policy = Policy { format = 1, literals = ["VERY_SECRET_123"] };
    let binding = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    if args[0] == "inspect-running" {
        let row = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("running work missing"); } };
        if row.value.work.phase != "running" || row.value.work.reserved.calls != 7 || row.value.work.reserved.generation != 286720 ||
            row.value.work.settled != None() || row.value.events.turns != 0 { abort("running work changed across process"); }
        let chat = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { abort("chat missing"); } };
        match admit("again", "private-workspace", "note.txt", "Change value", chat, policy, binding) {
            Ok(_) => { abort("running work was readmitted"); } Err(_) => {}
        }
        println("PASS running reservation retained and readmission refused"); return 0;
    }
    match create_chat(policy, binding, false) { Ok(_) => {} Err(_) => { abort("chat create refused"); } }
    let fresh = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { abort("chat missing"); } };
    match reserve_chat(fresh, "First question", policy, binding) { Ok(_) => {} Err(_) => { abort("chat reserve refused"); } }
    let running = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { abort("running chat missing"); } };
    match finish_chat(running, chat_result(running.value.chat.invocation.maximum), policy, binding) { Ok(_) => {} Err(_) => { abort("chat finish refused"); } }
    let chat = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { abort("completed chat missing"); } };
    let ticket = match admit("work-one", "private-workspace", "note.txt", "Change value", chat, policy, binding) {
        Ok(item) => item, Err(_) => { abort("work admission refused"); }
    };
    match claim(ticket, policy, binding) { Ok(_) => {} Err(_) => { abort("work claim refused"); } }
    if args[0] == "reserve" { println("PASS running reservation saved"); return 0; }
    if args[0] == "finish" {
        match finish(ticket, "Done", spent(), [], policy, binding) { Ok(_) => { abort("empty facts accepted"); } Err(_) => {} }
        let records = [Event { role = "user", kind = "request", name = "", text = "Change value" },
            Event { role = "tool", kind = "result", name = "read", text = large_event() },
            Event { role = "tool", kind = "applied", name = "edit", text = "work-one" },
            Event { role = "assistant", kind = "answer", name = "", text = "Done" }];
        match finish(ticket, "Done", spent(), records, policy, binding) { Ok(_) => {} Err(_) => { abort("work finish refused"); } }
        match finish(ticket, "Done", spent(), records, policy, binding) { Ok(_) => { abort("stale finish accepted"); } Err(_) => {} }
        let row = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("completed work missing"); } };
        let text = match decode(row.value.events.events[1].text, policy) { Ok(item) => item, Err(_) => { abort("work event decode failed"); } };
        if row.value.work.phase != "complete" || row.value.work.reserved.calls != 0 || row.value.events.turns != 1 ||
            !starts_with(text, "complete: blue\n[REDACTED]\n") || byte_len(text) < 262144 { abort("completed work or event changed"); }
        println("PASS work completion and filtered event saved atomically"); return 0;
    }
    abort("unknown work probe phase");
}
