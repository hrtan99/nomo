module nomo.entry.read_model_tools_chat;

import std.io.{println, read_line};
import std.text.{len, split, to_string_i32, starts_with};
import std.collections.len as count;
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import nomo.cli.read_cli.parse_line;
import nomo.model.model_tool_contract.allowed_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.read_tool_contract.{Ledger, fresh};
import nomo.harness.read_tool_chat_contract.{fresh_invocation, admission_error, extended_invocation, extended_admission_error};
import nomo.harness.read_tool_chat.run_turn;

flow help() -> unit {
    println("Nomo model/tool harness chat: new --allow FILE[,FILE...] [--turns 4]; /help, /exit, EOF.");
    println("Limits: 2 admitted tasks by default, or 4 with --turns 4; 8 raw reads including EOF; payload <=128 before trim, <=130 with LF/CRLF; child 1..256, parent 1..512, complete model contexts <=2048.");
    println("Default maximum: 14 steps / 8 calls / 16384 output-token allowance / 2 tools / 8192 scan; --turns 4: 28 / 16 / 32768 / 4 / 16384. Allowances are not measured usage.");
    println("Each turn reserves 7/4/8192/1/4096 before work. Only the immediately preceding successful task, child/tool result and answer are carried forward, as data, never replayed actions.");
    println("Read size is checked after reading. One serial depth-one child per turn; fresh in-memory only. No resume, writes, commands, recursion or live setup. Host aborts may leave reservations unresolved.");
}

flow ledger(prefix: string, state: Ledger, maximum: Ledger) -> unit {
    println(prefix + "LEDGER steps=" + to_string_i32(state.steps) + "/" + to_string_i32(maximum.steps) + " calls=" + to_string_i32(state.calls) + "/" + to_string_i32(maximum.calls) + " tokens=" +
        to_string_i32(state.tokens) + "/" + to_string_i32(maximum.tokens) + " tools=" + to_string_i32(state.tools) + "/" + to_string_i32(maximum.tools) + " scan=" + to_string_i32(state.scan) +
        "/" + to_string_i32(maximum.scan) + " reserved_steps=0 reserved_calls=0 reserved_tokens=0 reserved_tools=0 reserved_scan=0");
}

flow stop(reason: string, turns: i32, lines: i32, state: Ledger, maximum: Ledger) -> unit {
    println("STOP " + reason + " turns=" + to_string_i32(turns) + " lines=" + to_string_i32(lines));
    ledger("", state, maximum);
}

flow refused(error: string) -> i32 { println("REFUSED " + error); let state = fresh_invocation(); ledger("", fresh(), state.maximum); return 1; }

flow line_error(raw: string) -> string {
    if byte_count(utf8_encode(raw)) > 130 { return "raw input exceeds 128 UTF-8 bytes plus LF/CRLF"; }
    var last = ""; var previous = "";
    for character in split(raw, "") limit Iterations(132) {
        if character != "" { previous = last; last = character; }
    }
    var framing: usize = 0;
    if last == "\n" { framing = 1; if previous == "\r" { framing = 2; } }
    if byte_count(utf8_encode(raw)) - framing > 128 { return "raw input exceeds 128 UTF-8 bytes plus LF/CRLF"; }
    return "";
}

public flow run(args: Array<string>) -> i32 {
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") { help(); return 0; }
    if count(args) != 3 && count(args) != 5 { return refused("expected new --allow FILE[,FILE...] [--turns 4] or standalone help"); }
    if args[0] != "new" || args[1] != "--allow" { return refused("expected new --allow FILE[,FILE...] [--turns 4] or standalone help"); }
    if count(args) == 5 && (args[3] != "--turns" || args[4] != "4") { return refused("only --turns 4 is supported"); }
    if len(args[2]) > 195 { return refused("raw allowlist exceeds 195 characters"); }
    let allowed = split(args[2], ",");
    let invalid_allowed = allowed_error(allowed); if invalid_allowed != "" { return refused(invalid_allowed); }
    let extended = count(args) == 5;
    let turn_limit = if extended { 4 } else { 2 };
    var state = if extended { extended_invocation() } else { fresh_invocation() };
    var lines: i32 = 0;
    println("Nomo model/tool harness chat (fresh, non-durable). Only the immediately preceding turn is retained; /help for limits; /exit to quit.");
    while lines < 8 limit Iterations(8) {
        lines = lines + 1;
        let raw = read_line();
        if raw == "" { stop("EOF", state.admitted, lines, state.usage, state.maximum); return 0; }
        let framing = line_error(raw);
        if framing != "" { println("REFUSED " + framing); }
        else { match parse_line(raw) {
            Err(error) => { println("REFUSED " + error); },
            Ok(command) => {
                if command.kind == "exit" { stop("exit", state.admitted, lines, state.usage, state.maximum); return 0; }
                if command.kind == "help" { help(); }
                else {
                    let invalid = question_error(command.text);
                    if invalid != "" { println("REFUSED " + invalid); }
                    else if starts_with(command.text, "/") { println("REFUSED unknown slash command"); }
                    else {
                        if state.admitted >= turn_limit { println("REFUSED turn limit reached"); stop("turn limit", state.admitted, lines, state.usage, state.maximum); return 1; }
                        let capacity = if extended { extended_admission_error(state.usage) } else { admission_error(state.usage, state.maximum) };
                        if capacity != "" { println("REFUSED " + capacity); stop("budget", state.admitted, lines, state.usage, state.maximum); return 1; }
                        println("TURN " + to_string_i32(state.admitted + 1) + " USER " + command.text);
                        let result = run_turn(command.text, allowed, state);
                        if !result.resolved { return 1; }
                        state = result.state;
                        ledger("TURN " + to_string_i32(state.admitted) + " ", state.usage, state.maximum);
                        if result.status != 0 { stop("turn failed", state.admitted, lines, state.usage, state.maximum); return 1; }
                    }
                }
            }
        }; }
    }
    println("REFUSED input read limit reached; start a new in-memory invocation");
    stop("input limit", state.admitted, lines, state.usage, state.maximum);
    return 1;
}
