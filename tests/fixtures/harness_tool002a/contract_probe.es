module app.contract_probe;

import std.io.println;
import std.text.char_count as len;
import nomo.core.conversation.{Event, State, add};
import nomo.model.model_tool_contract.{Session};
import nomo.model.model_tool_contract.Context as ChildContext;
import nomo.model.model_tool_contract.context_error as child_context_error;
import nomo.harness.harness_tool_contract.{Ledger, Observed, inspect};
import nomo.harness.harness_tool_chat_contract.{Previous, Context, Invocation, empty, seed, prior_error, context_error,
    invocation_error, admission_error, combine, inspect_turn, default_maximum, fresh_invocation, turn_error};

type Check = { label: string, mode: string, ledger: Ledger, usage: Ledger, maximum: Ledger, invocation: Invocation,
    prior: Previous, context: Context, child: Session, legacy: Session, status: i32, allowed: Array<string>,
    accepted: bool, expected_ledger: Ledger, expected_observed: Observed };

flow event(role: string, kind: string, name: string, text: string) -> Event {
    return Event { role = role, kind = kind, name = name, text = text };
}
flow sample(events: Array<Event>, spent: i32, calls: usize, tokens: usize, tools: usize, scan: usize) -> Session {
    var characters: usize = 0;
    for item in events limit Iterations(12) { characters = characters + len(item.name) + len(item.text); }
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
    if item.mode == "defaults" {
        let zero = Ledger { steps = 0, calls = 0, tokens = 0, tools = 0, scan = 0 };
        return default_maximum() == item.maximum && fresh_invocation() ==
            Invocation { usage = zero, maximum = item.maximum, admitted = 0, prior = empty() };
    }
    if item.mode == "admission" { return (admission_error(item.ledger, item.maximum) == "") == item.accepted; }
    if item.mode == "invocation" { return (invocation_error(item.ledger) == "") == item.accepted; }
    if item.mode == "turn" { return (turn_error(item.invocation) == "") == item.accepted; }
    if item.mode == "prior" { return (prior_error(item.prior) == "") == item.accepted; }
    if item.mode == "context" { return (context_error(item.context) == "") == item.accepted; }
    if item.mode == "combine" {
        return match combine(item.ledger, item.usage, item.maximum) {
            Ok(value) => item.accepted && value == item.expected_ledger, Err(_) => !item.accepted
        };
    }
    if item.mode == "zero_proven" {
        let input = add(seed("Q", item.prior), event("user", "input", "", "T"));
        let actual_context = ChildContext { history = input.events, allowed = item.allowed, final_only = false };
        if child_context_error(actual_context) !=
            "model context exceeds 2048 serialized characters" { return false; }
    }
    if item.mode == "inspect" || item.mode == "projection" || item.mode == "zero_proven" {
        let actual = inspect_turn(item.child, item.status, "Q", "T", item.allowed, item.prior);
        if item.mode == "projection" {
            let original = inspect(item.legacy, item.status, "Q", "T", item.allowed);
            return match actual {
                Ok(value) => match original { Ok(before) => item.accepted && value == before && value == item.expected_observed,
                    Err(_) => false }, Err(_) => false
            };
        }
        return match actual { Ok(value) => item.accepted && value == item.expected_observed, Err(_) => !item.accepted };
    }
    return false;
}

// Pure product contracts only; this observer is not a Console/model/File test.
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(128) { if !evaluate(item) { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(128) {
        if !evaluate(item) { println("FAIL " + item.label); abort("pure tool-chat contract check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
