module app.contract_probe;

import std.io.println;
import std.text.{char_count as len, split};
import nomo.core.text.printable;
import nomo.core.conversation.Event;
import nomo.harness.harness_tool_contract.Ledger;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, Completed, TurnResult, Context, turn_error, context_error};
import nomo.session.harness_checkpoint.{Identity, Checkpoint};
import nomo.session.harness_successor.{Successor, restore, validate, encode, decode, from_turn};
import nomo.cli.harness_successor_args.parse;

type Check = { label: string, mode: string, saved: Successor, requested: Identity, predecessor: Identity,
    raw: string, accepted: bool, status: i32, resolved: bool, present: bool, mutation: string,
    args: Array<string>, help: bool };

flow slash() -> string { return std.text.from_char('\\'); }
flow event(role: string, kind: string, name: string, text: string) -> Event {
    return Event { role = role, kind = kind, name = name, text = text };
}
flow previous(saved: Checkpoint) -> Previous {
    return Previous { task = saved.task, result = saved.result, tool = saved.tool, outcome = saved.outcome, answer = saved.answer };
}
// Synthetic typed receipts are inputs to the actual pure mapper, not model runs.
flow receipt(item: Check) -> TurnResult {
    let saved = item.saved;
    var prior = Previous { task = saved.task, result = saved.result, tool = saved.tool, outcome = saved.outcome, answer = saved.answer };
    var admitted = saved.admitted; var usage = saved.usage; var maximum = saved.maximum;
    if item.mutation == "prior" { prior = previous(saved.predecessor); }
    if item.mutation == "admitted" { admitted = 1; }
    if item.mutation == "usage" { usage = saved.predecessor.usage; }
    if item.mutation == "maximum" { maximum = Ledger { steps = 13, calls = 8, tokens = 16384, tools = 2, scan = 8192 }; }
    let state = Invocation { usage = usage, maximum = maximum, admitted = admitted, prior = prior };
    let completed = Completed { request = saved.request, task = saved.task, result = saved.result,
        tool = saved.tool, outcome = saved.outcome, answer = saved.answer, records = saved.records };
    var selected: Option<Completed> = None(); if item.present { selected = Some(completed); }
    return TurnResult { status = item.status, state = state, resolved = item.resolved, completed = selected };
}
flow checks() -> Array<Check> { return __CHECKS__; }
flow failure(error: string) -> bool { return len(error) > 0 && len(error) <= 160 && printable(error); }
flow result(actual: Result<Successor, string>, item: Check) -> bool {
    return match actual { Ok(value) => item.accepted && value == item.saved,
        Err(error) => !item.accepted && failure(error) };
}
flow evaluate(item: Check) -> bool {
    if item.mode == "validate" { return result(validate(item.saved, item.requested, item.predecessor), item); }
    if item.mode == "decode" { return result(decode(item.raw), item); }
    if item.mode == "from_turn" {
        return result(from_turn(item.requested, item.saved.predecessor, item.saved.predecessor_version, receipt(item)), item);
    }
    if item.mode == "roundtrip" || item.mode == "encode" {
        return match encode(item.saved) {
            Ok(raw) => item.accepted && raw == item.raw && result(decode(raw), item),
            Err(error) => !item.accepted && failure(error)
        };
    }
    if item.mode == "restore" {
        return match restore(item.saved.predecessor) {
            Ok(value) => item.accepted && value.usage == item.saved.predecessor.usage &&
                value.maximum == item.saved.predecessor.maximum && value.admitted == 1 &&
                value.prior == previous(item.saved.predecessor) && turn_error(value) == "",
            Err(error) => !item.accepted && failure(error)
        };
    }
    if item.mode == "third" { let turn = receipt(item); return (turn_error(turn.state) == "") == item.accepted; }
    if item.mode == "context" {
        let saved = item.saved;
        let context = Context { phase = "plan", request = saved.request, task = "", result = "", tool = "", outcome = "",
            allowed = saved.identity.allowed, prior = previous(saved.predecessor) };
        return (context_error(context) == "") == item.accepted;
    }
    if item.mode == "continue_args" || item.mode == "show_args" {
        return match parse(item.args, item.mode == "continue_args") {
            Ok(value) => item.accepted && value.help == item.help && (item.help ||
                (value.predecessor == item.predecessor && value.successor == item.requested &&
                value.request == if item.mode == "continue_args" { item.saved.request } else { "" })),
            Err(error) => !item.accepted && failure(error)
        };
    }
    return false;
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(256) { if !evaluate(item) { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(256) {
        if !evaluate(item) { println("FAIL " + item.label); abort("pure Harness successor contract check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
