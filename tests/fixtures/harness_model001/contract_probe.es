module nomo.harness_model_probe;

import std.io.{read_all, println};
import std.text.to_string_usize;
import std.json.{JsonValue, parse};
import std.agent.message.Message;
import nomo.harness.harness_model_contract.{Context, Ledger, fresh, bounded, decode_plan, context_error, charge_call, charge_boundary};

type Check = { label: string, mode: string, text: string, maximum: usize, context: Context,
    ledger: Ledger, accepted: bool, expected_text: string, expected: Ledger };

flow ledger_matches(value: Result<Ledger, string>, item: Check) -> bool {
    return match value {
        Ok(actual) => item.accepted && actual == item.expected,
        Err(_) => !item.accepted,
    };
}

// Defensive/pure API fixture, not a replacement for the actual product route.
flow observe(args: Array<string>) -> i32 {
    let raw = read_all();
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => abort("fixture JSON") };
    let message = Message.new(parsed);
    let conversion: Option<Message<Array<Check>>> = message.cast<Array<Check>>();
    let checks = match conversion { Some(value) => value.body, None() => abort("fixture typed inputs") };
    let zero = Ledger { steps = 0, calls = 0, tokens = 0 };
    if fresh() != zero { abort("fixture fresh ledger"); }
    var index: usize = 0;
    for item in checks limit Iterations(64) {
        println("CASE " + to_string_usize(index) + " " + item.label);
        var passed = false;
        if item.mode == "bounded" { passed = bounded(item.text, item.maximum) == item.accepted; }
        else if item.mode == "context" { passed = context_error(item.context) == item.expected_text; }
        else if item.mode == "call" { passed = ledger_matches(charge_call(item.ledger), item); }
        else if item.mode == "boundary" { passed = ledger_matches(charge_boundary(item.ledger), item); }
        else if item.mode == "decode" {
            passed = match decode_plan(item.text) {
                Ok(value) => item.accepted && value == item.expected_text,
                Err(_) => !item.accepted,
            };
        }
        if !passed { abort("pure model Harness contract assertion"); }
        println("PASS " + to_string_usize(index) + " " + item.label);
        index = index + 1;
    }
    println("PASS HARNESS_MODEL_PURE " + to_string_usize(index));
    return 0;
}
