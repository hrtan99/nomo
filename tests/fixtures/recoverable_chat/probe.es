module app.recoverable_chat_probe;

import std.io.println;
import nomo.core.conversation.Event;
import nomo.harness.harness_tool_contract.Ledger;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult};
import nomo.session.redaction.Policy;
import nomo.session.recoverable_chat_store.{create, load, reserve, finish, conversation, record_work};
import nomo.session.event_text_codec.decode;
import std.collections.len as count;

flow result(turn: i32, request: string, answer: string, maximum: Ledger) -> TurnResult {
    let prior = Previous { task = "Read config", result = answer, tool = "read", outcome = "complete: port=4321", answer = answer };
    let used = Ledger { steps = turn * 7, calls = turn * 4, tokens = turn * 270336, tools = turn, scan = turn * 4194560 };
    let state = Invocation { usage = used, maximum = maximum, admitted = turn, prior = prior };
    let records = [Event { role = "user", kind = "request", name = "", text = request },
        Event { role = "tool", kind = "result", name = "read", text = "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back VERY_SECRET_123" },
        Event { role = "assistant", kind = "final", name = "", text = answer }];
    let done = Completed { request = request, task = prior.task, result = prior.result, tool = prior.tool,
        outcome = prior.outcome, answer = prior.answer, records = records };
    return TurnResult { status = 0, state = state, resolved = true, completed = Some(done) };
}

flow large(label: string) -> string {
    var block = "0123456789abcdef"; var index: i32 = 0;
    while index < 13 limit Iterations(13) { block = block + block; index = index + 1; }
    return "complete: " + label + " " + block;
}

flow large_result(turn: i32, request: string, label: string, maximum: Ledger) -> TurnResult {
    let outcome = large(label); let answer = "captured " + label;
    let prior = Previous { task = "Read large evidence", result = answer, tool = "read", outcome = outcome, answer = answer };
    let used = Ledger { steps = turn * 7, calls = turn * 4, tokens = turn * 270336, tools = turn, scan = turn * 4194560 };
    let state = Invocation { usage = used, maximum = maximum, admitted = turn, prior = prior };
    var records = [Event { role = "user", kind = "request", name = "", text = request },
        Event { role = "main", kind = "tool", name = "read", text = outcome },
        Event { role = "assistant", kind = "answer", name = "", text = answer }];
    if label == "LATEST-PRIOR" { records = records.push(Event { role = "system", kind = "notice", name = "after-latest", text = "unique event after latest answer" }); }
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
        let done = result(1, "first question", "port 4321", prior.value.chat.invocation.maximum);
        match finish(prior, done, policy, binding) { Ok(_) => {} Err(_) => { abort("first finish refused"); } }
        match finish(prior, done, policy, binding) { Ok(_) => { abort("stale finish accepted"); } Err(_) => {} }
        println("PASS first completion"); return 0;
    }
    if args[0] == "reserve-second" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("first frame missing"); } };
        let tool = match decode(prior.value.events.events[2].text, policy) { Ok(value) => value, Err(_) => { abort("tool result decode refused"); } };
        if prior.value.events.turns != 1 || tool != "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back [REDACTED]" ||
            prior.value.chat.invocation.usage.calls != 4 { abort("first event or budget changed"); }
        match reserve(prior, "second question", policy, binding) { Ok(_) => {} Err(_) => { abort("second reservation refused"); } }
        println("PASS second reservation"); return 0;
    }
    if args[0] == "finish-second" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("second running frame missing"); } };
        let tool = match decode(prior.value.events.events[2].text, policy) { Ok(value) => value, Err(_) => { abort("tool result decode refused"); } };
        if prior.value.chat.phase != "running" || prior.value.events.turns != 1 || tool != "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back [REDACTED]" {
            abort("reserved frame changed across process");
        }
        match finish(prior, result(2, "second question", "port remains 4321", prior.value.chat.invocation.maximum), policy, binding) { Ok(_) => {} Err(_) => { abort("second finish refused"); } }
        println("PASS second completion"); return 0;
    }
    if args[0] == "inspect" {
        let final = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("final frame missing"); } };
        match load(policy, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
            Ok(_) => { abort("changed policy binding accepted"); } Err(_) => {}
        }
        let first = match decode(final.value.events.events[2].text, policy) { Ok(value) => value, Err(_) => { abort("first tool decode refused"); } };
        let second = match decode(final.value.events.events[6].text, policy) { Ok(value) => value, Err(_) => { abort("second tool decode refused"); } };
        if final.value.chat.phase != "ready" || final.value.chat.invocation.usage.calls != 8 || final.value.events.turns != 2 ||
            final.value.events.first_count != 4 || first != "complete: port=4321\nCHECK_OK\r\nliteral <LF>\tend utf8=港 \"quoted\" \\ back [REDACTED]" ||
            second != first { abort("final event or cumulative budget changed"); }
        println("PASS final reload"); return 0;
    }
    if args[0] == "reserve-third-large" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("two-turn frame missing"); } };
        match reserve(prior, "third question", policy, binding) { Ok(_) => {} Err(_) => { abort("third reservation refused"); } }
        println("PASS third reservation"); return 0;
    }
    if args[0] == "finish-third-large" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("third running frame missing"); } };
        match finish(prior, large_result(3, "third question", "EARLY-HISTORY", prior.value.chat.invocation.maximum), policy, binding) { Ok(_) => {} Err(_) => { abort("third finish refused"); } }
        println("PASS third large completion"); return 0;
    }
    if args[0] == "reserve-fourth-large" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("third frame missing"); } };
        match reserve(prior, "fourth question", policy, binding) { Ok(_) => {} Err(_) => { abort("fourth reservation refused"); } }
        println("PASS fourth reservation archived earlier large evidence"); return 0;
    }
    if args[0] == "finish-fourth-large" {
        let prior = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("fourth running frame missing"); } };
        match finish(prior, large_result(4, "fourth question", "LATEST-PRIOR", prior.value.chat.invocation.maximum), policy, binding) { Ok(_) => {} Err(_) => { abort("fourth finish refused"); } }
        let repeated = "captured LATEST-PRIOR";
        let work = [Event { role = "main", kind = "consume", name = "child-1", text = repeated },
            Event { role = "main", kind = "answer", name = "", text = repeated }];
        match record_work("after-latest", work, policy, binding) { Ok(_) => {} Err(_) => { abort("work facts after latest chat refused"); } }
        println("PASS fourth large completion and later same-text work facts"); return 0;
    }
    if args[0] == "inspect-conversation" {
        let final = match load(policy, binding) { Ok(Some(item)) => item, _ => { abort("four-turn frame missing"); } };
        let history = match conversation(final.value.events, final.value.chat.invocation.prior, policy, binding) { Ok(value) => value, Err(_) => { abort("conversation restore refused"); } };
        if final.value.events.turns != 4 || count(history) != 12 || history[2].text != "third question" || history[5].text != "fourth question" ||
            history[3].role != "main" || history[3].kind != "tool" || history[3].text != large("EARLY-HISTORY") ||
            history[6].role != "main" || history[6].kind != "tool" || history[6].name != "read" ||
            history[6].text != "Exact latest tool outcome supplied separately as current.prior.outcome for read stages or previous.outcome for work stages; duplicate text omitted." ||
            history[7].role != "assistant" || history[7].kind != "answer" || history[7].text != "captured LATEST-PRIOR" ||
            history[8].role != "system" || history[8].kind != "notice" || history[8].name != "after-latest" || history[8].text != "unique event after latest answer" ||
            history[9].role != "system" || history[9].kind != "work-boundary" || history[9].name != "after-latest" ||
            history[10].role != "main" || history[10].kind != "consume" || history[10].text != "captured LATEST-PRIOR" ||
            history[11].role != "main" || history[11].kind != "answer" || history[11].text != "captured LATEST-PRIOR" ||
            final.value.chat.invocation.prior.tool != "read" || final.value.chat.invocation.prior.outcome != large("LATEST-PRIOR") ||
            final.value.chat.invocation.prior.answer != "captured LATEST-PRIOR" { abort("archived/latest conversation content or order changed"); }
        println("PASS archived evidence restored and latest canonical references preserve event order"); return 0;
    }
    abort("unknown test phase");
}
