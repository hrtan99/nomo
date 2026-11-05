module app.contract_probe;

import std.io.println;
import std.text.split;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, parse, stringify};
import std.agent.message.Message;
import nomo.cli.harness_edit_args.Input;
import nomo.cli.harness_edit_args.parse as parse_args;
import nomo.harness.harness_edit_contract.{Context, Ledger, fresh, bump, ledger_error, context_error, decode_edit, decode_plan};

type Check = { label: string, passed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow child(raw: string, target: string, replacement: string, denied: bool) -> bool {
    return match decode_edit(raw) { Ok(value) => !denied && value.target == target && value.replacement == replacement, Err(_) => denied };
}
flow plan(raw: string, expected: string, denied: bool) -> bool {
    return match decode_plan(raw) { Ok(value) => !denied && value == expected, Err(_) => denied };
}
flow arguments(args: Array<string>, expected: Input, denied: bool) -> bool {
    return match parse_args(args) { Ok(value) => !denied && value == expected, Err(_) => denied };
}
flow contextual(value: Context, accepted: bool) -> bool { return (context_error(value) == "") == accepted; }
flow roundtrip(value: Context) -> bool {
    if context_error(value) != "" { return false; }
    let message = Message.new(value);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match converted { Some(item) => item.body, None() => { return false; } };
    let encoded = match stringify(data) { Ok(item) => item, Err(_) => { return false; } };
    if byte_count(utf8_encode(encoded)) > 65536 { return false; }
    let parsed = match parse(encoded) { Ok(item) => item, Err(_) => { return false; } };
    let parsed_message = Message.new(parsed);
    let decoded: Option<Message<Context>> = parsed_message.cast<Context>();
    return match decoded { Some(item) => item.body == value, None() => false };
}
flow blocked(state: Ledger, call: bool) -> bool { return match bump(state, call) { Ok(_) => false, Err(_) => true }; }
flow normal_ledger() -> bool {
    var state = fresh(); var step: usize = 0;
    for call in [true, false, true, false, false, true] limit Iterations(6) {
        state = match bump(state, call) { Ok(value) => value, Err(_) => { return false; } };
        step = step + 1;
        if step == 4 && !blocked(state, true) { return false; }
        if step == 5 && (state.calls != 2 || state.tokens != 36864 || state.native_tokens != 98304 || state.boundaries != 3) { return false; }
    }
    let expected = Ledger { steps = 6, calls = 3, tokens = 38912, native_tokens = 163840, boundaries = 3 };
    return state == expected && ledger_error(state) == "" && blocked(state, true) && blocked(state, false);
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(24) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(24) {
        if !item.passed { println("FAIL " + item.label); abort("harness edit contract failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
