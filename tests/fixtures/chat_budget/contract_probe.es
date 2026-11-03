module app.main;

import std.io.println;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult, empty};
import nomo.harness.harness_tool_contract.{Ledger, fresh as fresh_ledger};
import nomo.harness.read_tool_chat_contract.{multi_maximum, multi_wide_maximum};
import nomo.session.chat_session_contract.{Session, fresh, fresh_events, invalid, begin, complete};

flow completed(request: string, maximum: Ledger, tokens: i32) -> TurnResult {
    let prior = Previous { task = "Read", result = "Answer", tool = "", outcome = "", answer = "Answer" };
    let usage = Ledger { steps = 5, calls = 3, tokens = tokens, tools = 0, scan = 0 };
    let selected = Invocation { usage = usage, maximum = maximum, admitted = 1, prior = prior };
    let done = Completed { request = request, task = prior.task, result = prior.result, tool = prior.tool, outcome = prior.outcome, answer = prior.answer, records = [] };
    return TurnResult { status = 0, state = selected, resolved = true, completed = Some(done) };
}
public flow probe(args: Array<string>) -> i32 ![Console, Error<std.io.IOError>, Error<IndexError>] {
    let new = fresh_events();
    if new.format != 11 || new.invocation.maximum != multi_wide_maximum(32) || invalid(new) != "" { abort("new event session changed"); }
    let mismatched = Session { format = 11, phase = "ready", invocation = Invocation { usage = fresh_ledger(), maximum = multi_maximum(32), admitted = 0, prior = empty() }, last_request = "", pending = "" };
    if invalid(mismatched) == "" { abort("new format with old allowance accepted"); }
    let reserved = match begin(new, "question") { Ok(value) => value, Err(_) => { abort("new reservation refused"); } };
    match begin(reserved, "repeat") { Ok(_) => { abort("running reservation retried"); } Err(_) => {} }
    match complete(reserved, completed("question", multi_wide_maximum(32), 8192)) { Ok(_) => { abort("undercharged new model accepted"); } Err(_) => {} }
    let saved = match complete(reserved, completed("question", multi_wide_maximum(32), 12288)) { Ok(value) => value, Err(_) => { abort("new accounting refused"); } };
    if saved.invocation.usage.tokens != 12288 || saved.phase != "ready" { abort("new usage changed"); }
    let legacy_invocation = Invocation { usage = fresh_ledger(), maximum = multi_maximum(32), admitted = 0, prior = empty() };
    let legacy = Session { format = 9, phase = "ready", invocation = legacy_invocation, last_request = "", pending = "" };
    let inflated = Session { format = 9, phase = "ready", invocation = Invocation { usage = fresh_ledger(), maximum = multi_wide_maximum(32), admitted = 0, prior = empty() }, last_request = "", pending = "" };
    if invalid(inflated) == "" { abort("old format with wide allowance accepted"); }
    let old = match begin(legacy, "question") { Ok(value) => value, Err(_) => { abort("legacy reservation refused"); } };
    if old.format != 9 || old.invocation.maximum != multi_maximum(32) { abort("legacy allowance changed"); }
    let old_saved = match complete(old, completed("question", multi_maximum(32), 8192)) { Ok(value) => value, Err(_) => { abort("legacy accounting refused"); } };
    if old_saved.invocation.usage.tokens != 8192 { abort("legacy usage changed"); }
    if fresh().format != 12 { abort("new two-turn format missing"); }
    println("PASS new and legacy reservations"); return 0;
}
