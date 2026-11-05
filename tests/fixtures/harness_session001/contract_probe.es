module app.contract_probe;

import std.io.println;
import std.text.{char_count as len, split};
import nomo.core.text.printable;
import nomo.core.conversation.Event;
import nomo.harness.harness_tool_contract.Ledger;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult};
import nomo.session.harness_checkpoint.{Identity, Checkpoint, identity_error, validate, encode, decode, from_turn};

type Check = { label: string, mode: string, saved: Checkpoint, requested: Identity,
    turn: TurnResult, raw: string, accepted: bool, expected: Checkpoint };

flow slash() -> string { return std.text.from_char('\\'); }

flow event(role: string, kind: string, name: string, text: string) -> Event {
    return Event { role = role, kind = kind, name = name, text = text };
}

// Synthetic typed receipts exercise the real mapper; they are not model runs.
flow receipt(saved: Checkpoint, status: i32, resolved: bool, present: bool) -> TurnResult {
    let prior = Previous { task = saved.task, result = saved.result, tool = saved.tool,
        outcome = saved.outcome, answer = saved.answer };
    let state = Invocation { usage = saved.usage, maximum = saved.maximum, admitted = saved.admitted, prior = prior };
    let completed = Completed { request = saved.request, task = saved.task, result = saved.result,
        tool = saved.tool, outcome = saved.outcome, answer = saved.answer, records = saved.records };
    var selected: Option<Completed> = None();
    if present { selected = Some(completed); }
    return TurnResult { status = status, state = state, resolved = resolved, completed = selected };
}

flow checks() -> Array<Check> { return __CHECKS__; }

flow result(actual: Result<Checkpoint, string>, item: Check) -> bool {
    return match actual {
        Ok(value) => item.accepted && value == item.expected,
        Err(error) => !item.accepted && len(error) > 0 && len(error) <= 160 && printable(error)
    };
}

flow evaluate(item: Check) -> bool {
    if item.mode == "identity" { return (identity_error(item.requested) == "") == item.accepted; }
    if item.mode == "validate" { return result(validate(item.saved, item.requested), item); }
    if item.mode == "decode" { return result(decode(item.raw), item); }
    if item.mode == "from_turn" { return result(from_turn(item.requested, item.turn), item); }
    if item.mode == "roundtrip" || item.mode == "encode" {
        return match encode(item.saved) {
            Ok(raw) => item.accepted && raw == item.raw && result(decode(raw), item),
            Err(error) => !item.accepted && len(error) > 0 && len(error) <= 160 && printable(error)
        };
    }
    return false;
}

// Pure product contracts only. Console below transports the assertion results.
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(256) { if !evaluate(item) { return false; } }
    return true;
}

public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(256) {
        if !evaluate(item) { println("FAIL " + item.label); abort("pure Harness checkpoint contract check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
