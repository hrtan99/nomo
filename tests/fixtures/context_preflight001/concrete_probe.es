module app.contract_probe;

import std.io.println;
import std.text.split;
import std.collections.len as count;
import std.json.parse;
import std.agent.message.Message;
import nomo.core.conversation.Event;
import nomo.model.tool_context.Context;
import nomo.context.preflight.{Measurement, Refusal, measure_context, measure_text};
import nomo.context.selection.{EventPolicy, SelectionRefusal, select};

type Check = { label: string, passed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow unknown_tokens(value: Measurement) -> bool {
    return match value.tokens { None() => true, Some(_) => false };
}
flow measured(raw: string, encoded: string, size: usize, maximum: usize) -> bool {
    return match measure_text(raw, maximum) {
        Ok(value) => value.encoded == encoded && value.encoded_bytes == size && unknown_tokens(value),
        Err(_) => false,
    };
}
flow measure_refused(raw: string, maximum: usize, expected: Refusal) -> bool {
    return match measure_text(raw, maximum) { Ok(_) => false, Err(error) => error == expected };
}
flow decoded_context(raw: string, expected: Context) -> bool {
    let json = match parse(raw) { Ok(value) => value, Err(_) => { return false; } };
    let message = Message.new(json);
    let converted: Option<Message<Context>> = message.cast<Context>();
    return match converted { Some(value) => value.body == expected, None() => false };
}
flow chosen(input: Context, policies: Array<EventPolicy>, maximum: usize,
    expected: Context, selected: Array<usize>, omitted: Array<usize>, size: usize) -> bool {
    return match select(input, policies, maximum) {
        Ok(value) => value.context == expected && value.selected == selected && value.omitted == omitted &&
            value.omitted_count == count(omitted) && value.measurement.encoded_bytes == size &&
            unknown_tokens(value.measurement) && decoded_context(value.measurement.encoded, expected),
        Err(_) => false,
    };
}
flow selection_refused(input: Context, policies: Array<EventPolicy>, maximum: usize, expected: SelectionRefusal) -> bool {
    return match select(input, policies, maximum) { Ok(_) => false, Err(error) => error == expected };
}
flow repeatable(input: Context, policies: Array<EventPolicy>, maximum: usize) -> bool {
    let first = match select(input, policies, maximum) { Ok(value) => value, Err(_) => { return false; } };
    return match select(input, policies, maximum) { Ok(second) => second == first, Err(_) => false };
}
// The Context type has only recursive string/bool leaves. This deliberately
// makes no claim about generic numeric typed-input or Binding serialization.
flow context_measured(input: Context, maximum: usize, size: usize) -> bool {
    return match measure_context(input, maximum) {
        Ok(value) => value.encoded_bytes == size && unknown_tokens(value) && decoded_context(value.encoded, input),
        Err(_) => false,
    };
}
flow context_refused(input: Context, maximum: usize, expected: Refusal) -> bool {
    return match measure_context(input, maximum) { Ok(_) => false, Err(error) => error == expected };
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(64) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(64) {
        if !item.passed { println("FAIL " + item.label); abort("context preflight pure contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
