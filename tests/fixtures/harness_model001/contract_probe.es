module nomo.harness_model_probe;

import std.io.read_all;
import std.io.println;
import std.text.from_usize;
import std.json.JsonValue;
import std.json.parse;
import std.agent.message.Message;
import nomo.domain.harness.read.TextContext as Context;
import nomo.domain.harness.read.Ledger;
import nomo.domain.harness.read.text_fresh as fresh;
import nomo.domain.harness.read.bounded;
import nomo.domain.harness.read.text_decode_plan as decode_plan;
import nomo.domain.harness.read.text_context_error as context_error;
import nomo.domain.harness.read.charge_call;
import nomo.domain.harness.read.charge_boundary;


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
        println("CASE " + from_usize(index) + " " + item.label);
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
        println("PASS " + from_usize(index) + " " + item.label);
        index = index + 1;
    }
    println("PASS HARNESS_MODEL_PURE " + from_usize(index));
    return 0;
}
