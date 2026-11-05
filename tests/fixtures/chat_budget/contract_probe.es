module app.main;

import std.io.println;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult, empty};
import nomo.harness.harness_tool_contract.{Ledger, fresh as fresh_ledger};
import nomo.harness.read_tool_chat_contract.{multi_maximum, multi_wide_maximum, multi_input_maximum, multi_input_reasoning_maximum, multi_large_maximum, multi_resilient_maximum};
import nomo.harness.read_tool_chat.{MainMode, main_mode};
import nomo.harness.chat_budget_policy.{SelectedBudget, select};
import nomo.session.chat_session_contract.{Session, fresh, fresh_events, fresh_high_input_events, invalid, begin, complete};

flow completed(request: string, maximum: Ledger, tokens: i32) -> TurnResult {
    let prior = Previous { task = "Read", result = "Answer", tool = "", outcome = "", answer = "Answer" };
    let usage = Ledger { steps = 5, calls = 3, tokens = tokens, tools = 0, scan = 0 };
    let selected = Invocation { usage = usage, maximum = maximum, admitted = 1, prior = prior };
    let done = Completed { request = request, task = prior.task, result = prior.result, tool = prior.tool, outcome = prior.outcome, answer = prior.answer, records = [] };
    return TurnResult { status = 0, state = selected, resolved = true, completed = Some(done) };
}
flow high_input_child(value: Invocation) -> bool {
    return match select(value, true) {
        SelectedBudget.Multi(policy) => policy.high_input_child(),
        SelectedBudget.Single(_) => false,
    };
}
flow reasoning_child(value: Invocation) -> bool {
    return match select(value, true) {
        SelectedBudget.Multi(policy) => policy.reasoning_child(),
        SelectedBudget.Single(_) => false,
    };
}
public flow probe(args: Array<string>) -> i32 ![Console, Error<std.io.IOError>, Error<IndexError>] {
    let new = fresh_events();
    if new.format != 16 || new.invocation.maximum != multi_resilient_maximum(48) || invalid(new) != "" { abort("new event session changed"); }
    let mismatched = Session { format = 11, phase = "ready", invocation = Invocation { usage = fresh_ledger(), maximum = multi_maximum(32), admitted = 0, prior = empty() }, last_request = "", pending = "" };
    if invalid(mismatched) == "" { abort("new format with old allowance accepted"); }
    let reserved = match begin(new, "question") { Ok(value) => value, Err(_) => { abort("new reservation refused"); } };
    match begin(reserved, "repeat") { Ok(_) => { abort("running reservation retried"); } Err(_) => {} }
    match complete(reserved, completed("question", multi_resilient_maximum(48), 12288)) { Ok(_) => { abort("undercharged new model accepted"); } Err(_) => {} }
    let early = match complete(reserved, completed("question", multi_resilient_maximum(48), 266240)) { Ok(value) => value, Err(_) => { abort("early final accounting refused"); } };
    if early.invocation.usage.tokens != 266240 || invalid(early) != "" { abort("early final usage changed"); }
    let saved = match complete(reserved, completed("question", multi_resilient_maximum(48), 393216)) { Ok(value) => value, Err(_) => { abort("new accounting refused"); } };
    if saved.invocation.usage.tokens != 393216 || saved.phase != "ready" { abort("new usage changed"); }
    let input = fresh_high_input_events();
    if input.format != 18 || input.invocation.maximum != multi_input_reasoning_maximum(48) || invalid(input) != "" || main_mode(input.invocation) != MainMode.HighInput || !high_input_child(input.invocation) || !reasoning_child(input.invocation) { abort("high-input event session changed"); }
    if high_input_child(new.invocation) { abort("resilient session selected high-input child"); }
    let input_reserved = match begin(input, "question") { Ok(value) => value, Err(_) => { abort("high-input reservation refused"); } };
    match complete(input_reserved, completed("question", multi_input_reasoning_maximum(48), 20480)) { Ok(_) => { abort("legacy accounting accepted for reasoning high-input session"); } Err(_) => {} }
    let input_saved = match complete(input_reserved, completed("question", multi_input_reasoning_maximum(48), 32768)) { Ok(value) => value, Err(_) => { abort("high-input accounting refused"); } };
    if input_saved.invocation.usage.tokens != 32768 || input_saved.phase != "ready" { abort("high-input usage changed"); }
    let legacy_input = Session { format = 17, phase = "ready", invocation = Invocation { usage = fresh_ledger(), maximum = multi_input_maximum(48), admitted = 0, prior = empty() }, last_request = "", pending = "" };
    if invalid(legacy_input) != "" || !high_input_child(legacy_input.invocation) || reasoning_child(legacy_input.invocation) { abort("legacy high-input session changed"); }
    let legacy_input_reserved = match begin(legacy_input, "question") { Ok(value) => value, Err(_) => { abort("legacy high-input reservation refused"); } };
    let legacy_input_saved = match complete(legacy_input_reserved, completed("question", multi_input_maximum(48), 20480)) { Ok(value) => value, Err(_) => { abort("legacy high-input accounting refused"); } };
    if legacy_input_saved.invocation.usage.tokens != 20480 { abort("legacy high-input usage changed"); }
    let legacy_invocation = Invocation { usage = fresh_ledger(), maximum = multi_maximum(32), admitted = 0, prior = empty() };
    let legacy = Session { format = 9, phase = "ready", invocation = legacy_invocation, last_request = "", pending = "" };
    let inflated = Session { format = 9, phase = "ready", invocation = Invocation { usage = fresh_ledger(), maximum = multi_wide_maximum(32), admitted = 0, prior = empty() }, last_request = "", pending = "" };
    if invalid(inflated) == "" { abort("old format with wide allowance accepted"); }
    let old = match begin(legacy, "question") { Ok(value) => value, Err(_) => { abort("legacy reservation refused"); } };
    if old.format != 9 || old.invocation.maximum != multi_maximum(32) { abort("legacy allowance changed"); }
    let old_saved = match complete(old, completed("question", multi_maximum(32), 8192)) { Ok(value) => value, Err(_) => { abort("legacy accounting refused"); } };
    if old_saved.invocation.usage.tokens != 8192 { abort("legacy usage changed"); }
    let prior = Previous { task = "Read", result = "Answer", tool = "read", outcome = "complete: data", answer = "Answer" };
    let late_usage = Ledger { steps = 517, calls = 282, tokens = 1155072, tools = 141, scan = 591432960 };
    let late = Session { format = 14, phase = "ready", invocation = Invocation { usage = late_usage, maximum = multi_wide_maximum(48), admitted = 47, prior = prior }, last_request = "question", pending = "" };
    if invalid(late) != "" { abort("47th turn refused"); }
    let last = match begin(late, "last") { Ok(value) => value, Err(_) => { abort("48th turn refused"); } };
    let done_usage = Ledger { steps = 528, calls = 288, tokens = 1179648, tools = 144, scan = 604016640 };
    let done_invocation = Invocation { usage = done_usage, maximum = multi_wide_maximum(48), admitted = 48, prior = prior };
    let done = Completed { request = "last", task = prior.task, result = prior.result, tool = prior.tool, outcome = prior.outcome, answer = prior.answer, records = [] };
    let final = match complete(last, TurnResult { status = 0, state = done_invocation, resolved = true, completed = Some(done) }) { Ok(value) => value, Err(_) => { abort("48th completion refused"); } };
    if final.phase != "complete" || final.invocation.maximum.tokens != 1179648 { abort("new lifetime limit changed"); }
    match begin(final, "overflow") { Ok(_) => { abort("49th turn accepted"); } Err(_) => {} }
    let large_usage = Ledger { steps = 517, calls = 282, tokens = 13090816, tools = 141, scan = 591432960 };
    let large = Session { format = 15, phase = "ready", invocation = Invocation { usage = large_usage, maximum = multi_large_maximum(48), admitted = 47, prior = prior }, last_request = "question", pending = "" };
    let large_last = match begin(large, "last") { Ok(value) => value, Err(_) => { abort("large final reservation refused"); } };
    let large_done = Ledger { steps = 528, calls = 288, tokens = 13369344, tools = 144, scan = 604016640 };
    let large_invocation = Invocation { usage = large_done, maximum = multi_large_maximum(48), admitted = 48, prior = prior };
    let large_final = match complete(large_last, TurnResult { status = 0, state = large_invocation, resolved = true, completed = Some(done) }) { Ok(value) => value, Err(_) => { abort("large final settlement refused"); } };
    if large_final.phase != "complete" { abort("large final phase changed"); }
    let old32 = Session { format = 13, phase = "ready", invocation = Invocation { usage = fresh_ledger(), maximum = multi_wide_maximum(32), admitted = 0, prior = empty() }, last_request = "", pending = "" };
    if invalid(old32) != "" { abort("legacy 32-turn session refused"); }
    if fresh().format != 12 { abort("new two-turn format missing"); }
    println("PASS new and legacy reservations"); return 0;
}
