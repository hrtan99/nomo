module nomo.entry.model_tools_chat_loop;

import std.io.{println, read_line};
import std.text.{char_count as len, len as byte_len, split, from_i32, starts_with, ends_with};
import std.collections.len as count;
import nomo.core.read_text.within;
import nomo.cli.cli_request.parse_line as parse_ascii;
import nomo.cli.read_cli.parse_line as parse_unicode;
import nomo.model.model_tool_contract.{allowed_error, question_error as ascii_question_error};
import nomo.model.read_protocol.question_error as unicode_question_error;
import nomo.harness.harness_tool_contract.{Ledger, fresh};
import nomo.harness.harness_tool_chat_contract.{Invocation, fresh_invocation, admission_error};
import nomo.harness.read_tool_chat_contract.{extended_invocation, extended_admission_error};
import nomo.harness.harness_tool_chat.run_turn as run_ascii_turn;
import nomo.harness.read_tool_chat.run_turn as run_unicode_turn;

flow help(unicode: bool) -> unit {
    println(if unicode { "Nomo model/tool harness chat: new --allow FILE[,FILE...] [--turns 4]; /help, /exit, EOF." } else { "Nomo model/tool harness chat: new --allow FILE[,FILE]; /help, /exit, EOF." });
    println(if unicode { "Limits: 2 admitted tasks by default, or 4 with --turns 4; 8 raw reads including EOF; payload <=128 before trim, <=130 with LF/CRLF; child 1..256, parent 1..512, complete model contexts <=2048." } else { "Limits: 2 admitted tasks, 8 raw reads including EOF; payload <=128 before trim, <=130 with LF/CRLF; child 1..256, parent 1..512, complete model contexts <=2048." });
    println(if unicode { "Default maximum: 14 steps / 8 calls / 16384 output-token allowance / 2 tools / 32768 scan; --turns 4: 28 / 16 / 32768 / 4 / 65536. Allowances are not measured usage." } else { "Invocation maximum: 14 steps / 8 calls / 16384 token allowance / 2 read-or-search tools / 8192 scan allowance; allowances are not measured usage." });
    println(if unicode { "Each turn reserves 7/4/8192/1/4096 before work. Only the immediately preceding successful task, child/tool result and answer are carried forward, as data, never replayed actions." } else { "Each turn reserves 7/4/8192/1/4096 before work. Prior successful delegated task, child/tool result and parent answer are data, never replayed actions." });
    println("Read size is checked after reading. One serial depth-one child per turn; fresh in-memory only. No resume, writes, commands, recursion or live setup. Host aborts may leave reservations unresolved.");
}

flow displayed_maximum(unicode: bool, maximum: Ledger) -> Ledger {
    return if unicode { maximum } else { Ledger { steps = 14, calls = 8, tokens = 16384, tools = 2, scan = 8192 } };
}
flow ledger(prefix: string, state: Ledger, maximum: Ledger) -> unit {
    println(prefix + "LEDGER steps=" + from_i32(state.steps) + "/" + from_i32(maximum.steps) + " calls=" + from_i32(state.calls) + "/" + from_i32(maximum.calls) + " tokens=" +
        from_i32(state.tokens) + "/" + from_i32(maximum.tokens) + " tools=" + from_i32(state.tools) + "/" + from_i32(maximum.tools) + " scan=" + from_i32(state.scan) +
        "/" + from_i32(maximum.scan) + " reserved_steps=0 reserved_calls=0 reserved_tokens=0 reserved_tools=0 reserved_scan=0");
}
flow stop(reason: string, lines: i32, state: Invocation, unicode: bool) -> unit {
    println("STOP " + reason + " turns=" + from_i32(state.admitted) + " lines=" + from_i32(lines));
    ledger("", state.usage, displayed_maximum(unicode, state.maximum));
}
flow refused(error: string, unicode: bool) -> i32 {
    println("REFUSED " + error); let state = fresh_invocation();
    ledger("", fresh(), displayed_maximum(unicode, state.maximum)); return 1;
}
flow line_error(raw: string, unicode: bool) -> string {
    let size = if unicode { byte_len(raw) } else { len(raw) };
    let framing: usize = if ends_with(raw, "\r\n") { 2 } else { if ends_with(raw, "\n") { 1 } else { 0 } };
    if size > 130 || size - framing > 128 { return if unicode { "raw input exceeds 128 UTF-8 bytes plus LF/CRLF" } else { "raw input exceeds 128 characters plus LF/CRLF" }; }
    return "";
}

flow loop(allowed: Array<string>, initial: Invocation, unicode: bool, extended: bool) -> i32 {
    var state = initial; var lines: i32 = 0; let turn_limit = if extended { 4 } else { 2 };
    println(if unicode { "Nomo model/tool harness chat (fresh, non-durable). Only the immediately preceding turn is retained; /help for limits; /exit to quit." } else { "Nomo model/tool harness chat (fresh, non-durable). /help for limits; /exit to quit." });
    while lines < 8 limit Iterations(8) {
        lines = lines + 1; let raw = read_line();
        if raw == "" { stop("EOF", lines, state, unicode); return 0; }
        let framing = line_error(raw, unicode);
        if framing != "" { println("REFUSED " + framing); }
        else { match (if unicode { parse_unicode(raw) } else { parse_ascii(raw) }) {
            Err(error) => { println("REFUSED " + error); },
            Ok(command) => {
                if command.kind == "exit" { stop("exit", lines, state, unicode); return 0; }
                if command.kind == "help" { help(unicode); }
                else {
                    let invalid = if unicode { unicode_question_error(command.text) } else { ascii_question_error(command.text) };
                    if invalid != "" { println("REFUSED " + invalid); }
                    else if starts_with(command.text, "/") { println("REFUSED unknown slash command"); }
                    else {
                        if state.admitted >= turn_limit { println("REFUSED turn limit reached"); stop("turn limit", lines, state, unicode); return 1; }
                        let capacity = if extended { extended_admission_error(state.usage) } else { admission_error(state.usage, state.maximum) };
                        if capacity != "" { println("REFUSED " + capacity); stop("budget", lines, state, unicode); return 1; }
                        println("TURN " + from_i32(state.admitted + 1) + " USER " + command.text);
                        let result = if unicode { run_unicode_turn(command.text, allowed, state) } else { run_ascii_turn(command.text, allowed, state) };
                        if !result.resolved { return 1; }
                        state = result.state;
                        ledger("TURN " + from_i32(state.admitted) + " ", state.usage, displayed_maximum(unicode, state.maximum));
                        if result.status != 0 { stop("turn failed", lines, state, unicode); return 1; }
                    }
                }
            }
        }; }
    }
    println("REFUSED input read limit reached; start a new in-memory invocation");
    stop("input limit", lines, state, unicode); return 1;
}

public flow run_mode(args: Array<string>, unicode: bool) -> i32 {
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") { help(unicode); return 0; }
    let usage = if unicode { "expected new --allow FILE[,FILE...] [--turns 4] or standalone help" } else { "expected new --allow FILE[,FILE] or standalone help" };
    if (unicode && count(args) != 3 && count(args) != 5) || (!unicode && count(args) != 3) { return refused(usage, unicode); }
    if args[0] != "new" || args[1] != "--allow" { return refused(usage, unicode); }
    if unicode && count(args) == 5 && (args[3] != "--turns" || args[4] != "4") { return refused("only --turns 4 is supported", true); }
    if (unicode && !within(args[2], 195)) || (!unicode && len(args[2]) > 97) { return refused(if unicode { "raw allowlist exceeds 195 UTF-8 bytes" } else { "raw allowlist exceeds 97 characters" }, unicode); }
    let allowed = split(args[2], ","); let invalid = allowed_error(allowed); if invalid != "" { return refused(invalid, unicode); }
    let extended = unicode && count(args) == 5;
    return loop(allowed, if extended { extended_invocation() } else { fresh_invocation() }, unicode, extended);
}
