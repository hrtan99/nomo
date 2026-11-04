module nomo.agent.model_tool_controller;

import std.text.{len, to_string_usize};
import std.io.println;
import nomo.harness.model_plan_diagnostic.response_text;
import nomo.core.conversation.{State, capacity_error, stop};
import nomo.agent.loop.{emit, failure};
import nomo.model.model_tool_contract.{Session, Limits, Context, allowed_error, question_error, decode_reply, decode_work_reply, context_error, budget_error, charge_action};
import nomo.tools.read_contract.{outcome, display, ReadTools};
import nomo.context.selection.{EventPolicy, SelectionRefusal, select as select_context};
import nomo.harness.legacy_string_stages.LegacyChildModel;
public import nomo.model.model_tool_contract.LoopTurn;
type ModelAttempt = { state: Session, context: Context };

public flow history(session: Session, state: State) -> Session {
    return Session { history = state, calls = session.calls, tokens = session.tokens, tools = session.tools, scan = session.scan };
}

public flow failed(session: Session, message: string, status: i32) -> LoopTurn {
    let result = failure(session.history, message, status);
    return LoopTurn { state = history(session, result.state), status = status };
}

public flow capacity(session: Session, slots: usize, characters: usize) -> string {
    return capacity_error(session.history, slots, characters);
}

// Retain all task, parent, tool and confirmed outcome events. Only controller
// Model-text history is optional; state history/accounting is never rewritten.
public flow bounded_model_context(input: Context, maximum: usize) -> Result<Context, string> {
    var policies: Array<EventPolicy> = [];
    for event in input.history limit Iterations(32) {
        var policy = EventPolicy.Required;
        if event.role == "model" && event.kind == "text" { policy = EventPolicy.Optional; }
        if event.role == "user" && event.kind == "input" { policy = EventPolicy.Task; }
        policies = policies.push(policy);
    }
    let selected = match select_context(input, policies, maximum) {
        Ok(value) => value,
        Err(error) => {
            let message = match error {
                SelectionRefusal.InvalidPolicy => "invalid model context event policy",
                SelectionRefusal.InvalidContext => "invalid bounded model context",
                SelectionRefusal.InvalidLimit => "invalid model context byte limit",
                SelectionRefusal.Encoding => "model context encoding refused",
                SelectionRefusal.RequiredTooLarge => if maximum == 2048 { "required model context exceeds 2048 encoded UTF-8 bytes" } else { "required model context exceeds 8388608 encoded UTF-8 bytes" },
            };
            return Err(message);
        },
    };
    if selected.omitted_count > 0 {
        println("CONTEXT omitted " + to_string_usize(selected.omitted_count) + " optional history events; required facts retained.");
    }
    return Ok(selected.context);
}

// Reserve the attempted model event and its largest final/action/error output.
// The context includes all preceding events, never the not-yet-made request.
flow model_attempt(previous: Session, allowed: Array<string>, limits: Limits, final_only: bool) -> Result<ModelAttempt, LoopTurn> {
    var session = previous;
    let full = capacity(session, 2, 518);
    if full != "" {
        return Err(failed(history(session, stop(session.history)), full, 4));
    }
    let original = Context { history = session.history.events, allowed = allowed, final_only = final_only };
    let context = match bounded_model_context(original, 2048) {
        Ok(value) => value, Err(error) => { return Err(failed(session, error, 4)); }
    };
    var error = context_error(context);
    if error == "" { error = budget_error(session, limits, false); }
    if error != "" {
        return Err(failed(session, error, 4));
    }
    session = charge_action(session, false, limits);
    session = history(session, emit(session.history, "model", "text", "qwen", ""));
    return Ok(ModelAttempt { state = session, context = context });
}

// This same controller is used by scoped production and deterministic handlers.
public flow run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    if previous.history.stopped { return LoopTurn { state = previous, status = 4 }; }
    let full = capacity(previous, 1, 128);
    if full != "" { return failed(history(previous, stop(previous.history)), full, 4); }
    var invalid = question_error(raw);
    if invalid == "" { invalid = allowed_error(allowed); }
    if invalid != "" { return failed(previous, invalid, 2); }
    var session = history(previous, emit(previous.history, "user", "input", "", raw));
    let first = match model_attempt(session, allowed, limits, false) { Ok(value) => value, Err(error) => { return error; } };
    // Host failure aborts here, without a recoverable source error event.
    let first_raw = perform LegacyChildModel.infer(first.context);
    session = first.state;
    if inspect_all { println(response_text(first_raw, "read-child-action", "lab-qwen-", 384)); }
    let decoded = if work { decode_work_reply(first_raw, allowed, false) } else { decode_reply(first_raw, allowed, false) };
    let action = match decoded {
        Ok(action) => action,
        Err(error) => { return failed(session, error, 3); }
    };
    if action.operation == "final" {
        return LoopTurn { state = history(session, emit(session.history, "assistant", "final", "", action.text)), status = 0 };
    }
    // Selected request + bounded actual outcome, with a separate terminal reserve.
    let tool_full = capacity(session, 2, len(first_raw) + 284);
    if tool_full != "" { return failed(history(session, stop(session.history)), tool_full, 4); }
    session = history(session, emit(session.history, "model", "request", action.operation, first_raw));
    let exhausted = budget_error(session, limits, true);
    if exhausted != "" { return failed(session, exhausted, 4); }
    session = charge_action(session, true, limits);
    var result = outcome("refused", "unsupported operation", 0);
    if action.operation == "read" { result = display(perform ReadTools.read(action.files[0])); }
    else if action.operation == "search" { result = display(perform ReadTools.search(action.files, action.literal)); }
    // Smaller admission than scripted tools: retain the full result or refuse.
    if len(result.text) > 256 { result = outcome("refused", "tool result exceeds 256 display characters", result.scanned); }
    let data = result.status + ": " + result.text;
    if result.status != "complete" {
        return LoopTurn { state = history(session, emit(session.history, "tool", "error", action.operation, data)), status = 3 };
    }
    session = history(session, emit(session.history, "tool", "complete", action.operation, data));
    let second = match model_attempt(session, allowed, limits, true) { Ok(value) => value, Err(error) => { return error; } };
    let second_raw = perform LegacyChildModel.infer(second.context);
    if inspect_all { println(response_text(second_raw, "read-child-final", "lab-qwen-", 1152)); }
    let decoded_final = if work { decode_work_reply(second_raw, allowed, true) } else { decode_reply(second_raw, allowed, true) };
    let final = match decoded_final {
        Ok(action) => action,
        Err(error) => { return failed(second.state, error, 3); }
    };
    return LoopTurn { state = history(second.state, emit(second.state.history, "assistant", "final", "", final.text)), status = 0 };
}
