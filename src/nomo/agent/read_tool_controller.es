module nomo.agent.read_tool_controller;

import std.text.{len, contains, starts_with, trim};
import std.io.println;
import nomo.core.read_text.{safe, bounded};
import nomo.harness.model_plan_diagnostic.{response_text, response_error};
import nomo.core.conversation.{State, stop, charge};
import nomo.agent.model_tool_controller.{capacity, history, failed, bounded_model_context};
import nomo.agent.loop.emit;
import nomo.agent.conversation_events.emit as emit_event;
import nomo.model.conversation_output.ConversationOutput;
import nomo.model.model_tool_contract.{Session, Limits, Context, candidate_error, context_error, budget_error, charge_action, default_limits};
import nomo.tools.read_contract.{outcome, Outcome, ReadTools};
import nomo.tools.read_display.display;
import nomo.model.read_protocol.{decode_child, compact_frame};
import nomo.harness.legacy_string_stages.LegacyChildModel;
public import nomo.model.model_tool_contract.LoopTurn;
type ModelAttempt = { state: Session, context: Context };

flow emit_mode(state: State, role: string, kind: string, name: string, text: string, private_progress: bool) -> State {
    if !private_progress { return emit(state, role, kind, name, text); }
    return emit_event(state, role, kind, name, text) with {
        ConversationOutput.publish(event) => { println("CHILD EVENT " + role + " " + kind + " " + name + ": [REDACTED]"); resume (); }
    };
}


// Reserve the attempted model event and its largest final/action/error output.
// The context includes all preceding events, never the not-yet-made request.
flow model_attempt(previous: Session, allowed: Array<string>, limits: Limits, final_only: bool, private_progress: bool, chat: bool, expanded: bool, wide: bool) -> Result<ModelAttempt, LoopTurn> {
    var session = previous;
    let full = capacity(session, 2, 518);
    if full != "" {
        return Err(failed(history(session, stop(session.history)), full, 4));
    }
    let original = Context { history = session.history.events, allowed = allowed, final_only = final_only };
    let context = match bounded_model_context(original, 8388608) {
        Ok(value) => value, Err(error) => { return Err(failed(session, error, 4)); }
    };
    var error = if chat { "" } else { context_error(context) };
    if error == "" {
        if expanded {
            if session.history.spent >= 3 || session.calls >= 2 || session.tokens != session.calls * 4096 || session.tools > 1 || session.scan > 65540 { error = "expanded work model reservation exhausted"; }
        } else { error = budget_error(session, limits, false); }
    }
    if error != "" {
        return Err(failed(session, error, 4));
    }
    if expanded { session = Session { history = charge(session.history), calls = session.calls + 1, tokens = session.tokens + if final_only && wide { 131072 } else { 4096 }, tools = session.tools, scan = session.scan }; }
    else { session = charge_action(session, false, limits); }
    session = history(session, emit_mode(session.history, "model", "text", "qwen", "", private_progress));
    return Ok(ModelAttempt { state = session, context = context });
}

flow child_rejection(raw: string, phase: string, error: string) -> string {
    let text = trim(raw); let category = if len(raw) > 1152 { "limit" } else { if starts_with(text, "```") { "fence" } else { if starts_with(text, "{") { "object" } else { if starts_with(text, "[") { "frame" } else { "prose" } } } };
    return error + "; " + response_error(raw, phase, category, 1152);
}

flow tool_failure(result: Outcome) -> string {
    if contains(result.text, "file is not UTF-8") { return "non-UTF-8 file"; }
    if contains(result.text, "file exceeds 65536 bytes") || contains(result.text, "file exceeds 16384 bytes") || contains(result.text, "file exceeds 2048 bytes") { return "per-file byte limit"; }
    if contains(result.text, "file exceeds remaining scan allowance") { return "scan allowance"; }
    if result.status == "truncated" { return "match limit"; }
    return if result.status == "unsupported" { "unsupported output" } else { if result.status == "refused" { "refused input or limit" } else { "invalid tool outcome" } };
}

// A chat child may inspect several explicit candidates under a reserved limit.
flow run_multistep(raw: string, allowed: Array<string>, previous: Session, private_progress: bool) -> LoopTurn {
    if previous.history.stopped { return LoopTurn { state = previous, status = 4 }; }
    let invalid = candidate_error(allowed); if invalid != "" || !bounded(raw, 512) { return failed(previous, "invalid selected child context", 2); }
    var session = history(previous, emit_mode(previous.history, "user", "input", "", raw, private_progress));
    var calls: usize = 0; var tools: usize = 0;
    while calls < 4 limit Iterations(4) {
        let full = capacity(session, 4, 262688); if full != "" { return failed(history(session, stop(session.history)), full, 4); }
        let original = Context { history = session.history.events, allowed = allowed, final_only = tools == 3 };
        let context = match bounded_model_context(original, 8388608) { Ok(value) => value, Err(error) => { return failed(session, error, 4); } };
        session = Session { history = charge(session.history), calls = session.calls + 1, tokens = session.tokens + 4096, tools = session.tools, scan = session.scan };
        session = history(session, emit_mode(session.history, "model", "text", "qwen", "", private_progress));
        calls = calls + 1;
        if private_progress { println("CHILD STAGE model-action"); }
        let response = perform LegacyChildModel.infer(context);
        let action = match decode_child(response, allowed, tools == 3) { Ok(value) => value, Err(error) => { return failed(session, child_rejection(response, if tools == 3 { "read-child-final" } else { "read-child-action" }, error), 3); } };
        if action.operation == "final" { return LoopTurn { state = history(session, emit_mode(session.history, "assistant", "final", "", action.text, private_progress)), status = 0 }; }
        session = history(session, emit_mode(session.history, "model", "request", action.operation, compact_frame(response), private_progress));
        session = Session { history = charge(session.history), calls = session.calls, tokens = session.tokens, tools = session.tools + 1, scan = session.scan + 4194560 };
        tools = tools + 1;
        if private_progress { println("CHILD STAGE tool"); }
        var files = action.files;
        if action.operation == "search" && files[0] == "*" { for name in allowed limit Iterations(256) { files = files.push(name); } }
        let result = if action.operation == "read" { display(perform ReadTools.read(files[0])) } else { display(perform ReadTools.search(files, action.literal)) };
        if result.status == "incomplete" { println("Search incomplete: results are partial; some candidates were skipped or the match limit was reached."); }
        if (result.status != "complete" && !(action.operation == "search" && result.status == "incomplete")) || !safe(result.text, 262144) {
            println("CHILD TOOL FAILURE operation=" + action.operation + " category=" + tool_failure(result));
            return LoopTurn { state = history(session, emit_mode(session.history, "tool", "error", action.operation, result.status + ": " + result.text, private_progress)), status = 3 };
        }
        session = history(session, emit_mode(session.history, "tool", "complete", action.operation, result.status + ": " + result.text, private_progress));
    }
    return failed(session, "child model reservation exhausted", 4);
}

// This same controller is used by scoped production and deterministic handlers.
flow run_mode(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool, private_progress: bool, chat: bool, expanded: bool, wide: bool) -> LoopTurn {
    if previous.history.stopped { return LoopTurn { state = previous, status = 4 }; }
    let full = capacity(previous, 1, if work { 512 } else { 128 });
    if full != "" { return failed(history(previous, stop(previous.history)), full, 4); }
    var invalid = if work && !bounded(raw, 512) { "work delegation requires 1..512 safe UTF-8 bytes" } else { if work || bounded(raw, 128) { "" } else { "question requires 1..128 safe UTF-8 bytes, not only spaces" } };
    if invalid == "" { invalid = candidate_error(allowed); }
    if invalid != "" { return failed(previous, invalid, 2); }
    var session = history(previous, emit_mode(previous.history, "user", "input", "", raw, private_progress));
    let first = match model_attempt(session, allowed, limits, false, private_progress, chat, expanded, wide) { Ok(value) => value, Err(error) => { return error; } };
    // Host failure aborts here, without a recoverable source error event.
    if private_progress { println("CHILD STAGE model-action"); }
    let first_raw = perform LegacyChildModel.infer(first.context);
    session = first.state;
    if inspect_all { println(response_text(first_raw, "read-child-action", "lab-qwen-", 384)); }
    let decoded = decode_child(first_raw, allowed, false);
    let action = match decoded {
        Ok(action) => action,
        Err(error) => { return failed(session, child_rejection(first_raw, "read-child-action", error), 3); }
    };
    if action.operation == "final" {
        return LoopTurn { state = history(session, emit_mode(session.history, "assistant", "final", "", action.text, private_progress)), status = 0 };
    }
    if action.operation == "search" && action.files[0] == "*" { return failed(session, "whole-scope search requires a multi-step reservation", 3); }
    // Selected request + bounded actual outcome, with a separate terminal reserve.
    let tool_full = capacity(session, 2, len(first_raw) + 65556);
    if tool_full != "" { return failed(history(session, stop(session.history)), tool_full, 4); }
    session = history(session, emit_mode(session.history, "model", "request", action.operation, compact_frame(first_raw), private_progress));
    let exhausted = if expanded { if session.tools != 0 || session.scan != 0 || session.history.spent >= 3 { "expanded work tool reservation exhausted" } else { "" } } else { budget_error(session, limits, true) };
    if exhausted != "" { return failed(session, exhausted, 4); }
    session = if expanded { Session { history = charge(session.history), calls = session.calls, tokens = session.tokens, tools = session.tools + 1, scan = session.scan + 65540 } } else { charge_action(session, true, limits) };
    var result = outcome("refused", "unsupported operation", 0);
    if private_progress { println("CHILD STAGE tool"); }
    if action.operation == "read" { result = display(perform ReadTools.read(action.files[0])); }
    else if action.operation == "search" { result = display(perform ReadTools.search(action.files, action.literal)); }
    // Smaller admission than scripted tools: retain the full result or refuse.
    if !safe(result.text, 262144) { result = outcome("refused", "tool result exceeds 262144 display bytes", result.scanned); }
    let data = result.status + ": " + result.text;
    if result.status != "complete" {
        return LoopTurn { state = history(session, emit_mode(session.history, "tool", "error", action.operation, data, private_progress)), status = 3 };
    }
    session = history(session, emit_mode(session.history, "tool", "complete", action.operation, data, private_progress));
    let second = match model_attempt(session, allowed, limits, true, private_progress, chat, expanded, wide) { Ok(value) => value, Err(error) => { return error; } };
    if private_progress { println("CHILD STAGE model-final"); }
    let second_raw = perform LegacyChildModel.infer(second.context);
    if inspect_all { println(response_text(second_raw, "read-child-final", "lab-qwen-", 1152)); }
    let decoded_final = decode_child(second_raw, allowed, true);
    let final = match decoded_final {
        Ok(action) => action,
        Err(error) => { return failed(second.state, child_rejection(second_raw, "read-child-final", error), 3); }
    };
    return LoopTurn { state = history(second.state, emit_mode(second.state.history, "assistant", "final", "", final.text, private_progress)), status = 0 };
}

public flow run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, work, inspect_all, false, false, false, false);
}
public flow run_private_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, false, false, true, false, false, false);
}
public flow run_private_work_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, true, false, true, false, false, false);
}

// Chat accepts the same bounded task as work, retaining a larger explicitly
// measured context for prior-turn evidence and JSON escaping.
public flow run_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, private_progress: bool) -> LoopTurn {
    return run_mode(raw, allowed, limits, previous, true, false, private_progress, true, false, false);
}
public flow run_expanded_work_loop_controller(raw: string, allowed: Array<string>, previous: Session, wide: bool) -> LoopTurn {
    return run_mode(raw, allowed, default_limits(), previous, true, false, true, false, true, wide);
}

public flow run_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, private_progress: bool) -> LoopTurn {
    return run_multistep(raw, allowed, previous, private_progress);
}
