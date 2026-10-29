module app.context_caller_probe;

import std.io.println;
import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import nomo.core.conversation.{Event, State};
import nomo.model.model_tool_contract.{Session, Limits, context_error};
import nomo.model.tool_context.Context;
import nomo.context.preflight.{Refusal, measure_context};
import nomo.agent.model_tool.{LoopTurn, run_loop};

// These reports are observation values, not a claim that JsonValue measures
// arbitrary typed numeric Prompt.data inputs. Full typed equality is checked
// before the report is encoded, with unchanged declared constructor order.
flow report(value: LoopTurn) -> i32 {
    let message = Message.new(value);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match converted { Some(item) => item.body, None() => abort("caller report conversion") };
    let text = match stringify(json) { Ok(item) => item, Err(_) => abort("caller report encoding") };
    println("PROBE " + text);
    return 0;
}
public flow success(args: Array<string>) -> i32 {
    let previous = __SUCCESS_PREVIOUS__;
    let expected = __SUCCESS_EXPECTED__;
    let limits = Limits { steps = 3, calls = 1, tokens = 2048, scan = 4096 };
    let result = run_loop(__QUESTION__, ["docs/a.txt"], limits, previous);
    if result != expected { abort("actual caller whole success state differs"); }
    return report(result);
}
public flow negative(args: Array<string>) -> i32 {
    let previous = __NEGATIVE_PREVIOUS__;
    let complete = __NEGATIVE_CONTEXT__;
    // The old character guard admits this synthetic required history. Its
    // actual UTF-8 size must refuse before charge/inference in the real caller.
    if context_error(complete) != "" { abort("negative legacy character premise differs"); }
    let too_large = match measure_context(complete, 2048) {
        Ok(_) => false,
        Err(error) => error == Refusal.TooLarge,
    };
    if !too_large { abort("negative UTF-8 premise differs"); }
    let expected = __NEGATIVE_EXPECTED__;
    // Exhausted call/token budgets and the Model-deny profile are hard no-dispatch
    // backstops. The specific byte refusal must still precede budget_error.
    let limits = Limits { steps = 3, calls = 0, tokens = 0, scan = 4096 };
    let result = run_loop(__QUESTION__, ["docs/a.txt"], limits, previous);
    if result != expected { abort("actual caller whole precharge refusal state differs"); }
    return report(result);
}
