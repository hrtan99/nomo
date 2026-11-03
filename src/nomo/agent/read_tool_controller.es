module nomo.agent.read_tool_controller;

import std.text.{len, to_string_usize};
import std.io.println;
import nomo.core.read_text.{safe, bounded};
import nomo.harness.model_plan_diagnostic.response_text;
import nomo.core.conversation.{State, capacity_error, stop, charge};
import nomo.agent.loop.{emit, failure};
import nomo.agent.conversation_events.emit as emit_event;
import nomo.model.conversation_output.ConversationOutput;
import nomo.model.model_tool_contract.{Session, Limits, Context, candidate_error, context_error, budget_error, charge_action, default_limits};
import nomo.tools.read_contract.{outcome, ReadTools};
import nomo.tools.read_display.display;
import nomo.model.read_protocol.{question_error, decode_child, compact_frame};
import nomo.context.selection.{EventPolicy, SelectionRefusal, select as select_context};
import nomo.harness.legacy_string_stages.LegacyChildModel;
public import nomo.model.model_tool_contract.LoopTurn;
type ModelAttempt = { state: Session, context: Context };

flow emit_mode(state: State, role: string, kind: string, name: string, text: string, private_progress: bool) -> State {
    if !private_progress { return emit(state, role, kind, name, text); }
    return emit_event(state, role, kind, name, text) with {
        ConversationOutput.publish(event) => { println("CHILD EVENT " + role + " " + kind + " " + name + ": [REDACTED]"); resume (); }
    };
}


flow history(session: Session, state: State) -> Session {
    return Session { history = state, calls = session.calls, tokens = session.tokens, tools = session.tools, scan = session.scan };
}

flow failed(session: Session, message: string, status: i32) -> LoopTurn {
    let result = failure(session.history, message, status);
    return LoopTurn { state = history(session, result.state), status = status };
}

flow capacity(session: Session, slots: usize, characters: usize) -> string {
    return capacity_error(session.history, slots, characters);
}

// Retain all task, parent, tool and confirmed outcome events. Only controller
// Model-text history is optional; state history/accounting is never rewritten.
flow bounded_model_context(input: Context, maximum: usize) -> Result<Context, string> {
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
                SelectionRefusal.RequiredTooLarge => "required model context exceeds 262144 encoded UTF-8 bytes",
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
flow model_attempt(previous: Session, allowed: Array<string>, limits: Limits, final_only: bool, private_progress: bool, chat: bool, expanded: bool) -> Result<ModelAttempt, LoopTurn> {
    var session = previous;
    let full = capacity(session, 2, 518);
    if full != "" {
        return Err(failed(history(session, stop(session.history)), full, 4));
    }
    let original = Context { history = session.history.events, allowed = allowed, final_only = final_only };
    let context = match bounded_model_context(original, 262144) {
        Ok(value) => value, Err(error) => { return Err(failed(session, error, 4)); }
    };
    var error = if chat { "" } else { context_error(context) };
    if error == "" {
        if expanded {
            if session.history.spent >= 3 || session.calls >= 2 || session.tokens != session.calls * 4096 || session.tools > 1 || session.scan > 16384 { error = "expanded work model reservation exhausted"; }
        } else { error = budget_error(session, limits, false); }
    }
    if error != "" {
        return Err(failed(session, error, 4));
    }
    if expanded { session = Session { history = charge(session.history), calls = session.calls + 1, tokens = session.tokens + 4096, tools = session.tools, scan = session.scan }; }
    else { session = charge_action(session, false, limits); }
    session = history(session, emit_mode(session.history, "model", "text", "qwen", "", private_progress));
    return Ok(ModelAttempt { state = session, context = context });
}

// A chat child may inspect several explicit candidates under a reserved limit.
flow run_multistep(raw: string, allowed: Array<string>, previous: Session, private_progress: bool) -> LoopTurn {
    if previous.history.stopped { return LoopTurn { state = previous, status = 4 }; }
    let invalid = candidate_error(allowed); if invalid != "" || !bounded(raw, 512) { return failed(previous, "invalid selected child context", 2); }
    var session = history(previous, emit_mode(previous.history, "user", "input", "", raw, private_progress));
    var calls: usize = 0; var tools: usize = 0;
    while calls < 4 limit Iterations(4) {
        let full = capacity(session, 4, 66080); if full != "" { return failed(history(session, stop(session.history)), full, 4); }
        let original = Context { history = session.history.events, allowed = allowed, final_only = tools == 3 };
        let context = match bounded_model_context(original, 262144) { Ok(value) => value, Err(error) => { return failed(session, error, 4); } };
        session = Session { history = charge(session.history), calls = session.calls + 1, tokens = session.tokens + 2048, tools = session.tools, scan = session.scan };
        session = history(session, emit_mode(session.history, "model", "text", "qwen", "", private_progress));
        calls = calls + 1;
        if private_progress { println("CHILD STAGE model-action"); }
        let response = perform LegacyChildModel.infer(context);
        let action = match decode_child(response, allowed, tools == 3) { Ok(value) => value, Err(error) => { return failed(session, error, 3); } };
        if action.operation == "final" { return LoopTurn { state = history(session, emit_mode(session.history, "assistant", "final", "", action.text, private_progress)), status = 0 }; }
        session = history(session, emit_mode(session.history, "model", "request", action.operation, compact_frame(response), private_progress));
        session = Session { history = charge(session.history), calls = session.calls, tokens = session.tokens, tools = session.tools + 1, scan = session.scan + 16384 };
        tools = tools + 1;
        if private_progress { println("CHILD STAGE tool"); }
        let result = if action.operation == "read" { display(perform ReadTools.read(action.files[0])) } else { display(perform ReadTools.search(action.files, action.literal)) };
        if result.status != "complete" || !safe(result.text, 65536) {
            return LoopTurn { state = history(session, emit_mode(session.history, "tool", "error", action.operation, result.status + ": " + result.text, private_progress)), status = 3 };
        }
        session = history(session, emit_mode(session.history, "tool", "complete", action.operation, "complete: " + result.text, private_progress));
    }
    return failed(session, "child model reservation exhausted", 4);
}

// This same controller is used by scoped production and deterministic handlers.
flow run_mode(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool, private_progress: bool, chat: bool, expanded: bool) -> LoopTurn {
    if previous.history.stopped { return LoopTurn { state = previous, status = 4 }; }
    let full = capacity(previous, 1, if work { 512 } else { 128 });
    if full != "" { return failed(history(previous, stop(previous.history)), full, 4); }
    var invalid = if work && !bounded(raw, 512) { "work delegation requires 1..512 safe UTF-8 bytes" } else { if work { "" } else { question_error(raw) } };
    if invalid == "" { invalid = candidate_error(allowed); }
    if invalid != "" { return failed(previous, invalid, 2); }
    var session = history(previous, emit_mode(previous.history, "user", "input", "", raw, private_progress));
    let first = match model_attempt(session, allowed, limits, false, private_progress, chat, expanded) { Ok(value) => value, Err(error) => { return error; } };
    // Host failure aborts here, without a recoverable source error event.
    if private_progress { println("CHILD STAGE model-action"); }
    let first_raw = perform LegacyChildModel.infer(first.context);
    session = first.state;
    if inspect_all { println(response_text(first_raw, "read-child-action", "lab-qwen-", 384)); }
    let decoded = decode_child(first_raw, allowed, false);
    let action = match decoded {
        Ok(action) => action,
        Err(error) => { return failed(session, error, 3); }
    };
    if action.operation == "final" {
        return LoopTurn { state = history(session, emit_mode(session.history, "assistant", "final", "", action.text, private_progress)), status = 0 };
    }
    // Selected request + bounded actual outcome, with a separate terminal reserve.
    let tool_full = capacity(session, 2, len(first_raw) + 65556);
    if tool_full != "" { return failed(history(session, stop(session.history)), tool_full, 4); }
    session = history(session, emit_mode(session.history, "model", "request", action.operation, compact_frame(first_raw), private_progress));
    let exhausted = if expanded { if session.tools != 0 || session.scan != 0 || session.history.spent >= 3 { "expanded work tool reservation exhausted" } else { "" } } else { budget_error(session, limits, true) };
    if exhausted != "" { return failed(session, exhausted, 4); }
    session = charge_action(session, true, limits);
    var result = outcome("refused", "unsupported operation", 0);
    if private_progress { println("CHILD STAGE tool"); }
    if action.operation == "read" { result = display(perform ReadTools.read(action.files[0])); }
    else if action.operation == "search" { result = display(perform ReadTools.search(action.files, action.literal)); }
    // Smaller admission than scripted tools: retain the full result or refuse.
    if !safe(result.text, 65536) { result = outcome("refused", "tool result exceeds 65536 display bytes", result.scanned); }
    let data = result.status + ": " + result.text;
    if result.status != "complete" {
        return LoopTurn { state = history(session, emit_mode(session.history, "tool", "error", action.operation, data, private_progress)), status = 3 };
    }
    session = history(session, emit_mode(session.history, "tool", "complete", action.operation, data, private_progress));
    let second = match model_attempt(session, allowed, limits, true, private_progress, chat, expanded) { Ok(value) => value, Err(error) => { return error; } };
    if private_progress { println("CHILD STAGE model-final"); }
    let second_raw = perform LegacyChildModel.infer(second.context);
    if inspect_all { println(response_text(second_raw, "read-child-final", "lab-qwen-", 1152)); }
    let decoded_final = decode_child(second_raw, allowed, true);
    let final = match decoded_final {
        Ok(action) => action,
        Err(error) => { return failed(second.state, error, 3); }
    };
    return LoopTurn { state = history(second.state, emit_mode(second.state.history, "assistant", "final", "", final.text, private_progress)), status = 0 };
}

public flow run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, work, inspect_all, false, false, false);
}
public flow run_private_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, false, false, true, false, false);
}
public flow run_private_work_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, true, false, true, false, false);
}

// Chat accepts the same bounded task as work, retaining a larger explicitly
// measured context for prior-turn evidence and JSON escaping.
public flow run_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, private_progress: bool) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, true, false, private_progress, true, false);
}
public flow run_expanded_work_loop_controller(raw: string, allowed: Array<string>, previous: Session) -> LoopTurn {
    return run_mode(raw, allowed, default_limits(), previous, true, false, true, false, true);
}

public flow run_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, private_progress: bool) -> LoopTurn {
    return run_multistep(raw, allowed, previous, private_progress);
}
