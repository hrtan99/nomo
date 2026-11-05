module app.recoverable_chat_probe;

import std.io.println;
import nomo.core.conversation.Event;
import nomo.harness.harness_tool_contract.Ledger;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult, default_maximum};
import nomo.session.redaction.Policy;
import nomo.session.recoverable_chat_store.{create, load, reserve, finish};
import nomo.session.event_text_codec.decode;

flow result(turn: i32, request: string, answer: string) -> TurnResult {
    let prior = Previous { task = "Read config", result = answer, tool = "read", outcome = "complete: port=4321", answer = answer };
    let used = Ledger { steps = turn * 7, calls = turn * 4, tokens = turn * 8192, tools = turn, scan = turn * 4096 };
    let state = Invocation { usage = used, maximum = default_maximum(), admitted = turn, prior = prior };
    let records = [Event { role = "user", kind = "request", name = "", text = request },
        Event { role = "tool", kind = "result", name = "read", text = "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back VERY_SECRET_123" },
        Event { role = "assistant", kind = "final", name = "", text = answer }];
    let done = Completed { request = request, task = prior.task, result = prior.result, tool = prior.tool,
        outcome = prior.outcome, answer = prior.answer, records = records };
    return TurnResult { status = 0, state = state, resolved = true, completed = Some(done) };
}

public flow recoverable_chat_probe(args: Array<string>) -> i32 ![Console, Memory, Error<IOError>, Error<StorageError>, Error<IndexError>] {
    let policy = Policy { format = 1, literals = ["VERY_SECRET_123"] };
    let binding = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    if args[0] == "reserve-first" {
        match create(policy, binding, false) { Ok(_) => {} Err(_) => { abort("create refused"); } }
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("fresh frame missing"); } };
        match reserve(prior, "first question", policy, binding) { Ok(_) => {} Err(_) => { abort("first reservation refused"); } }
        println("PASS first reservation"); return 0;
    }
    if args[0] == "first-finish" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("running frame missing"); } };
        if prior.value.chat.phase != "running" || prior.value.events.turns != 0 { abort("running frame changed across process"); }
        match reserve(prior, "repeat", policy, binding) { Ok(_) => { abort("repeated running reservation accepted"); } Err(_) => {} }
        let done = result(1, "first question", "port 4321");
        match finish(prior, done, policy, binding) { Ok(_) => {} Err(_) => { abort("first finish refused"); } }
        match finish(prior, done, policy, binding) { Ok(_) => { abort("stale finish accepted"); } Err(_) => {} }
        println("PASS first completion"); return 0;
    }
    if args[0] == "reserve-second" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("first frame missing"); } };
        let tool = match decode(prior.value.events.events[1].text, policy) { Ok(value) => value, Err(_) => { abort("tool result decode refused"); } };
        if prior.value.events.turns != 1 || tool != "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back [REDACTED]" ||
            prior.value.chat.invocation.usage.calls != 4 { abort("first event or budget changed"); }
        match reserve(prior, "second question", policy, binding) { Ok(_) => {} Err(_) => { abort("second reservation refused"); } }
        println("PASS second reservation"); return 0;
    }
    if args[0] == "finish-second" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("second running frame missing"); } };
        let tool = match decode(prior.value.events.events[1].text, policy) { Ok(value) => value, Err(_) => { abort("tool result decode refused"); } };
        if prior.value.chat.phase != "running" || prior.value.events.turns != 1 || tool != "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back [REDACTED]" {
            abort("reserved frame changed across process");
        }
        match finish(prior, result(2, "second question", "port remains 4321"), policy, binding) { Ok(_) => {} Err(_) => { abort("second finish refused"); } }
        println("PASS second completion"); return 0;
    }
    if args[0] == "inspect" {
        let final = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("final frame missing"); } };
        match load(policy, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
            Ok(_) => { abort("changed policy binding accepted"); } Err(_) => {}
        }
        let first = match decode(final.value.events.events[1].text, policy) { Ok(value) => value, Err(_) => { abort("first tool decode refused"); } };
        let second = match decode(final.value.events.events[4].text, policy) { Ok(value) => value, Err(_) => { abort("second tool decode refused"); } };
        if final.value.chat.phase != "complete" || final.value.chat.invocation.usage.calls != 8 || final.value.events.turns != 2 ||
            final.value.events.first_count != 3 || first != "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back [REDACTED]" ||
            second != first { abort("final event or cumulative budget changed"); }
        println("PASS final reload"); return 0;
    }
    abort("unknown test phase");
}
