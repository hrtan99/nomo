module app.chat_four_probe;
import std.io.println;
import nomo.harness.harness_tool_contract.Ledger;
import nomo.harness.harness_tool_chat_contract.{Invocation, Previous, empty};
import nomo.harness.read_tool_chat_contract.{extended_invocation, extended_maximum, extended_admission_error, extended_turn_error, extended_combine};

flow ledger(steps: i32, calls: i32, tools: i32) -> Ledger {
    return Ledger { steps = steps, calls = calls, tokens = calls * 2048, tools = tools, scan = tools * 4096 };
}
flow prior(tool: string) -> Previous {
    return Previous { task = "task", result = "child", tool = tool, outcome = if tool == "" { "" } else { "complete: data" }, answer = "answer" };
}
flow invocation(usage: Ledger, turns: i32, selected: Previous) -> Invocation {
    return Invocation { usage = usage, maximum = extended_maximum(), admitted = turns, prior = selected };
}
flow checks() -> bool {
    if extended_turn_error(extended_invocation()) != "" { return false; }
    if extended_turn_error(invocation(ledger(7, 4, 1), 1, prior("read"))) != "" { return false; }
    // One tool and one direct completion; previous turn has no tool.
    if extended_turn_error(invocation(ledger(12, 7, 1), 2, prior(""))) != "" { return false; }
    // Two tools and one direct completion; previous turn used a tool.
    if extended_turn_error(invocation(ledger(19, 11, 2), 3, prior("read"))) != "" { return false; }
    if extended_turn_error(invocation(ledger(15, 9, 0), 3, prior("read"))) == "" { return false; }
    if extended_turn_error(invocation(ledger(19, 11, 2), 2, prior("read"))) == "" { return false; }
    if extended_turn_error(invocation(ledger(7, 4, 1), 1, empty())) == "" { return false; }
    let full = ledger(28, 16, 4);
    if extended_admission_error(full) == "" || extended_turn_error(invocation(full, 4, prior("read"))) == "" { return false; }
    if extended_admission_error(Ledger { steps = -1, calls = 0, tokens = 0, tools = 0, scan = 0 }) == "" { return false; }
    if extended_admission_error(Ledger { steps = 7, calls = 4, tokens = 8191, tools = 1, scan = 4096 }) == "" { return false; }
    if extended_admission_error(Ledger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4095 }) == "" { return false; }
    let total = match extended_combine(ledger(21, 12, 3), ledger(7, 4, 1)) { Ok(value) => value, Err(_) => { return false; } };
    if total != full { return false; }
    // A stopped partial turn remains counted; no next turn is authorized from it.
    let failed = match extended_combine(ledger(7, 4, 1), ledger(1, 1, 0)) { Ok(value) => value, Err(_) => { return false; } };
    if failed != ledger(8, 5, 1) || extended_turn_error(invocation(failed, 2, prior("read"))) == "" { return false; }
    match extended_combine(full, ledger(1, 1, 0)) { Ok(_) => { return false; } Err(_) => {} }
    return true;
}
public flow read_chat_four_probe(_args: Array<string>) -> i32 {
    if checks() { println("PASS four-turn admission and accounting"); return 0; }
    println("FAIL four-turn admission and accounting"); return 1;
}
