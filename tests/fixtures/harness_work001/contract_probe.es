module app.contract_probe;

import std.io.println;
import std.text.split;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.JsonValue;
import std.json.parse;
import std.json.stringify;
import std.agent.message.Message;
import nomo.adapters.cli.edit_input.Input;
import nomo.adapters.cli.edit_input.Work;
import nomo.adapters.cli.edit_input.harness_work_args_parse as parse_args;
import nomo.domain.harness.loop.ReadLedger;
import nomo.domain.harness.edit.EditLedger;
import nomo.domain.harness.edit.Context as EditContext;
import nomo.domain.harness.work.Evidence;
import nomo.domain.harness.work.Context;
import nomo.domain.harness.work.fresh;
import nomo.domain.harness.work.ledger_error;
import nomo.domain.harness.work.bump_edit;
import nomo.domain.harness.work.native_tokens;
import nomo.domain.harness.work.evidence_error;
import nomo.domain.harness.work.finish_evidence;
import nomo.domain.harness.work.context_error;
import nomo.domain.harness.work.WorkLedger;

type Check = { label: string, passed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow evidence(value: Evidence, accepted: bool) -> bool { return (evidence_error(value) == "") == accepted; }
flow finish(value: Evidence, summary: string, expected: Evidence, denied: bool) -> bool {
    return match finish_evidence(value, summary) { Ok(item) => !denied && item == expected, Err(_) => denied };
}
flow contextual(value: Context, accepted: bool) -> bool { return (context_error(value) == "") == accepted; }
flow roundtrip(value: Context) -> bool {
    if context_error(value) != "" { return false; }
    let message = Message.new(value); let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match conversion { Some(item) => item.body, None() => { return false; } };
    let encoded = match stringify(data) { Ok(item) => item, Err(_) => { return false; } };
    if byte_count(utf8_encode(encoded)) > 65536 { return false; }
    let parsed = match parse(encoded) { Ok(item) => item, Err(_) => { return false; } };
    let parsed_message = Message.new(parsed); let converted: Option<Message<Context>> = parsed_message.cast<Context>();
    return match converted { Some(item) => item.body == value, None() => false };
}
flow arguments(args: Array<string>, expected: Work, denied: bool) -> bool {
    return match parse_args(args) { Ok(value) => !denied && value == expected, Err(_) => denied };
}
flow blocked(state: WorkLedger) -> bool { return match bump_edit(state, true) { Ok(_) => false, Err(_) => true }; }
flow unused() -> bool {
    let state = fresh();
    return ledger_error(state) == "" && state.read.steps == 0 && state.read.calls == 0 && state.read.tokens == 0 &&
        state.edit.steps == 0 && state.edit.calls == 0 && state.edit.tokens == 0 && state.edit.native_tokens == 0 &&
        native_tokens(state) == 0 && blocked(state);
}
flow normal_ledger(read: ReadLedger) -> bool {
    let initial = fresh(); var state = WorkLedger { read = read, edit = initial.edit }; var step: usize = 0;
    if ledger_error(state) != "" || native_tokens(state) != 32768 { return false; }
    for call in [true, false, true, false, false, true] limit Iterations(6) {
        state = match bump_edit(state, call) { Ok(value) => value, Err(_) => { return false; } };
        step = step + 1;
        if state.read != read || ledger_error(state) != "" { return false; }
        if step == 5 && (state.edit.calls != 2 || state.edit.tokens != 36864 || native_tokens(state) != 131072) { return false; }
    }
    return state.read.steps + state.edit.steps == 13 && state.read.calls + state.edit.calls == 7 &&
        state.read.tokens + state.edit.tokens == 47104 && native_tokens(state) == 196608 && blocked(state);
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(20) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(20) {
        if !item.passed { println("FAIL " + item.label); abort("harness work contract failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
