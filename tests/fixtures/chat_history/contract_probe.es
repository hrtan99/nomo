module app.chat_session_contract_probe;

import std.io.println;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult, default_maximum};
import nomo.harness.harness_tool_contract.Ledger;
import nomo.session.chat_session_contract.{Session, fresh, invalid, begin, complete};

public flow outcome(turns: i32, request: string, answer: string) -> TurnResult {
    let prior = Previous { task = "Answer the question", result = answer, tool = "", outcome = "", answer = answer };
    let used = Ledger { steps = turns * 5, calls = turns * 3, tokens = turns * 6144, tools = 0, scan = 0 };
    let state = Invocation { usage = used, maximum = default_maximum(), admitted = turns, prior = prior };
    let done = Completed { request = request, task = prior.task, result = prior.result, tool = prior.tool,
        outcome = prior.outcome, answer = prior.answer, records = [] };
    return TurnResult { status = 0, state = state, resolved = true, completed = Some(done) };
}
public flow chat_session_contract_probe() -> i32 ![Console, Error<IOError>, Error<IndexError>] {
    let initial = fresh(); if invalid(initial) != "" { abort("fresh session invalid"); }
    let first = match begin(initial, "first question") { Ok(value) => value, Err(_) => { abort("first reservation refused"); } };
    match begin(first, "repeat") { Ok(_) => { abort("running reservation repeated"); } Err(_) => {} }
    match complete(first, outcome(1, "other question", "blue")) { Ok(_) => { abort("wrong question accepted"); } Err(_) => {} }
    let previous = match complete(first, outcome(1, "first question", "blue")) { Ok(value) => value, Err(_) => { abort("first result refused"); } };
    if previous.phase != "ready" || previous.invocation.prior.answer != "blue" { abort("first result changed"); }
    let second = match begin(previous, "second question") { Ok(value) => value, Err(_) => { abort("second reservation refused"); } };
    match complete(second, outcome(1, "second question", "green")) { Ok(_) => { abort("budget reset accepted"); } Err(_) => {} }
    let last = match complete(second, outcome(2, "second question", "green")) { Ok(value) => value, Err(_) => { abort("second result refused"); } };
    if last.phase != "complete" || last.invocation.prior.answer != "green" { abort("completed session changed"); }
    match begin(last, "third") { Ok(_) => { abort("third turn accepted"); } Err(_) => {} }
    println("PASS preserved budget and unresolved reservation"); return 0;
}
