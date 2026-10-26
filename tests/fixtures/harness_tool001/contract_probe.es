module app.contract_probe;

import std.io.println;
import std.text.len;
import nomo.core.conversation.{Event, State};
import nomo.model.model_tool_contract.Session;
import nomo.harness.harness_tool_contract.{Ledger, Context, Observed, fresh, bump, settle, inspect, context_error};

type Check = { label: string, mode: string, ledger: Ledger, child: Session, status: i32, context: Context,
    accepted: bool, expected_ledger: Ledger, expected_observed: Observed };

flow event(role: string, kind: string, name: string, text: string) -> Event {
    return Event { role = role, kind = kind, name = name, text = text };
}
flow sample(events: Array<Event>, spent: i32, calls: usize, tokens: usize, tools: usize, scan: usize) -> Session {
    var characters: usize = 0;
    for item in events limit Iterations(7) { characters = characters + len(item.name) + len(item.text); }
    return Session { history = State { events = events, characters = characters, spent = spent, stopped = false },
        calls = calls, tokens = tokens, tools = tools, scan = scan };
}
flow changed(child: Session, characters: usize, stopped: bool) -> Session {
    return Session { history = State { events = child.history.events, characters = characters,
        spent = child.history.spent, stopped = stopped }, calls = child.calls, tokens = child.tokens,
        tools = child.tools, scan = child.scan };
}
flow checks() -> Array<Check> { return __CHECKS__; }

flow evaluate(item: Check) -> bool {
    if item.mode == "inspect" {
        return match inspect(item.child, item.status, "Q", "T", ["a.txt"]) {
            Ok(value) => item.accepted && value == item.expected_observed, Err(_) => !item.accepted
        };
    }
    if item.mode == "settle" {
        return match settle(item.ledger, item.child) {
            Ok(value) => item.accepted && value == item.expected_ledger, Err(_) => !item.accepted
        };
    }
    if item.mode == "call" || item.mode == "boundary" {
        return match bump(item.ledger, item.mode == "call") {
            Ok(value) => item.accepted && value == item.expected_ledger, Err(_) => !item.accepted
        };
    }
    if item.mode == "context" { return (context_error(item.context) == "") == item.accepted; }
    return false;
}

public flow pure_probe() -> bool {
    for item in checks() limit Iterations(64) { if !evaluate(item) { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(64) {
        if !evaluate(item) { println("FAIL " + item.label); abort("pure tool-child contract check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
