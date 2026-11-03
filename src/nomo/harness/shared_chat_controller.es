module nomo.harness.shared_chat_controller;

import std.io.println;
import std.text.to_string_i32;
import nomo.core.conversation.{Event, State};
import nomo.model.model_tool_contract.{question_error, allowed_error, candidate_error};
import nomo.harness.harness_model_contract.{bounded, decode_plan};
import nomo.harness.harness_tool_contract.{Ledger, fresh, bump, settle, numbers};
import nomo.harness.harness_tool_chat_contract.{Previous, Context, Invocation, LocalTurn, TurnResult, Completed, empty, prior_error,
    context_error, seed, inspect_turn, turn_error, combine};
import nomo.harness.legacy_chat_stages.LegacyChatStages;
import nomo.model.read_protocol.question_error as unicode_question_error;
import nomo.model.read_protocol.decode_work_plan as unicode_decode_plan;
import nomo.core.read_text.bounded as unicode_bounded;
import nomo.harness.read_tool_chat_contract.prior_error as unicode_prior_error;
import nomo.harness.read_tool_chat_contract.context_error as unicode_context_error;
import nomo.harness.read_tool_chat_contract.inspect_turn as unicode_inspect_turn;
import nomo.harness.read_tool_chat_contract.turn_error as unicode_turn_error;
import nomo.harness.read_tool_chat_contract.{is_extended, extended_turn_error, extended_combine};
import nomo.harness.read_tool_chat_contract.{session_maximum, session_turn_error, session_combine, multi_maximum, multi_turn_error, multi_combine, multi_bump, multi_settle, inspect_multi_turn};

flow refused(usage: Ledger, error: string, resolved: bool) -> LocalTurn {
    println("REFUSED " + error);
    if !resolved { println("RESERVATION child-1 unresolved=true; returned child metadata refused"); }
    return LocalTurn { status = 1, usage = usage, selected = empty(), resolved = resolved, completed = None() };
}

flow completed(request: string, raw_plan: string, selected: Previous, child: State) -> Completed {
    var records = [Event { role = "user", kind = "request", name = "", text = request },
        Event { role = "main", kind = "plan", name = "", text = raw_plan },
        Event { role = "main", kind = "delegate", name = "child-1", text = selected.task }];
    for event in child.events limit Iterations(18) { records = records.push(event); }
    records = records.push(Event { role = "main", kind = "consume", name = "child-1", text = selected.result });
    if selected.tool != "" { records = records.push(Event { role = "main", kind = "tool", name = selected.tool, text = selected.outcome }); }
    records = records.push(Event { role = "main", kind = "answer", name = "", text = selected.answer });
    return Completed { request = request, task = selected.task, result = selected.result, tool = selected.tool,
        outcome = selected.outcome, answer = selected.answer, records = records };
}

flow total(before: Ledger, local: Ledger) -> Ledger {
    return Ledger { steps = before.steps + local.steps, calls = before.calls + local.calls, tokens = before.tokens + local.tokens,
        tools = before.tools + local.tools, scan = before.scan + local.scan };
}

flow stage(turn: i32, phase: string, before: Ledger, local: Ledger, multi: bool) -> unit {
    var steps: i32 = 0;
    if phase == "plan" { steps = if multi { 10 } else { 6 }; }
    if phase == "child" { steps = if multi { 9 } else { 5 }; }
    let calls = if phase == "aggregate" { 0 } else { if multi { 5 } else { 3 } };
    let tools = if phase == "aggregate" { 0 } else { if multi { 3 } else { 1 } };
    println("TURN " + to_string_i32(turn) + " STAGE " + phase + " " + numbers(total(before, local)) +
        " reserved_steps=" + to_string_i32(steps) + " reserved_calls=" + to_string_i32(calls) +
        " reserved_tokens=" + to_string_i32(calls * 2048) + " reserved_tools=" + to_string_i32(tools) +
        " reserved_scan=" + to_string_i32(tools * 16384));
    if phase == "child" {
        println(if multi { "RESERVATION child-1 steps=7 calls=4 tokens=8192 tools=3 scan=49152 tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true" } else { "RESERVATION child-1 steps=3 calls=2 tokens=4096 tools=1 scan=16384 tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true" });
    }
}

// The invocation supplies cumulative usage and a validated successful selection.
// Fresh local counters are a subledger of the already checked global reservation.
flow execute(request: string, allowed: Array<string>, prior: Previous, before: Ledger, turn: i32, unicode: bool, private_progress: bool, multi: bool) -> LocalTurn {
    var state = fresh();
    if turn < 1 || turn > 32 || (turn == 1 && prior.task != "") || (turn > 1 && prior.task == "") {
        return refused(state, "invalid turn selection", true);
    }
    let invalid = if unicode { unicode_question_error(request) } else { question_error(request) }; if invalid != "" { return refused(state, invalid, true); }
    let paths = if unicode { candidate_error(allowed) } else { allowed_error(allowed) }; if paths != "" { return refused(state, paths, true); }
    let previous = if unicode { unicode_prior_error(prior) } else { prior_error(prior) }; if previous != "" { return refused(state, previous, true); }
    let plan = Context { phase = "plan", request = request, task = "", result = "", tool = "", outcome = "", allowed = allowed, prior = prior };
    let invalid_plan = if unicode { unicode_context_error(plan) } else { context_error(plan) }; if invalid_plan != "" { return refused(state, invalid_plan, true); }
    state = match if multi { multi_bump(state, true) } else { bump(state, true) } { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    stage(turn, "plan", before, state, multi);
    let raw = perform LegacyChatStages.main(plan);
    let decoded = if unicode { unicode_decode_plan(raw) } else { decode_plan(raw) };
    let task = match decoded { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    state = match if multi { multi_bump(state, false) } else { bump(state, false) } { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    if private_progress { println("EVENT main -> child-1 request child-1: [REDACTED]"); }
    else { println("EVENT main -> child-1 request child-1: " + task); }
    stage(turn, "child", before, state, multi);
    let child = perform LegacyChatStages.child(task, allowed, seed(request, prior), multi);
    let inspected = if multi { inspect_multi_turn(child.state, child.status, request, task, allowed, prior) } else { if unicode { unicode_inspect_turn(child.state, child.status, request, task, allowed, prior) }
        else { inspect_turn(child.state, child.status, request, task, allowed, prior) } };
    let observed = match inspected {
        Ok(value) => value, Err(error) => { return refused(state, error, false); }
    };
    if child.state.calls != 0 {
        state = match if multi { multi_settle(state, child.state) } else { settle(state, child.state) } { Ok(value) => value, Err(error) => { return refused(state, error, false); } };
    }
    println("SETTLED child-1 " + numbers(total(before, state)) + " released_steps=" + to_string_i32((if multi { 9 } else { 5 }) - state.steps) +
        " released_calls=" + to_string_i32((if multi { 5 } else { 3 }) - state.calls) + " released_tokens=" + to_string_i32((if multi { 10240 } else { 6144 }) - state.tokens) +
        " released_tools=" + to_string_i32((if multi { 3 } else { 1 }) - state.tools) + " released_scan=" + to_string_i32((if multi { 49152 } else { 16384 }) - state.scan) + " unresolved=false");
    if child.status != 0 { return refused(state, "child returned failure; no aggregation", true); }
    if !(if unicode { unicode_bounded(observed.result, 256) } else { bounded(observed.result, 256) }) { return refused(state, "invalid bounded child result", true); }
    if private_progress { println("EVENT child-1 -> main result child-1: [REDACTED]"); }
    else { println("EVENT child-1 -> main result child-1: " + observed.result); }
    state = match if multi { multi_bump(state, false) } else { bump(state, false) } { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    if private_progress { println("EVENT main -> main consume child-1: [REDACTED]"); }
    else { println("EVENT main -> main consume child-1: " + observed.result); }
    if observed.tool != "" {
        if private_progress { println("EVENT main -> main tool " + observed.tool + ": [REDACTED]"); }
        else { println("EVENT main -> main tool " + observed.tool + ": " + observed.outcome); }
    }
    let aggregate = Context { phase = "aggregate", request = request, task = task, result = observed.result,
        tool = observed.tool, outcome = observed.outcome, allowed = allowed, prior = prior };
    let invalid_aggregate = if unicode { unicode_context_error(aggregate) } else { context_error(aggregate) }; if invalid_aggregate != "" { return refused(state, invalid_aggregate, true); }
    state = match if multi { multi_bump(state, true) } else { bump(state, true) } { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    stage(turn, "aggregate", before, state, multi);
    let answer = perform LegacyChatStages.main(aggregate);
    if !(if unicode { unicode_bounded(answer, 512) } else { bounded(answer, 512) }) { return refused(state, "invalid bounded final answer", true); }
    println("FINAL " + answer);
    let selected = Previous { task = task, result = observed.result, tool = observed.tool, outcome = observed.outcome, answer = answer };
    return LocalTurn { status = 0, usage = state, selected = selected, resolved = true,
        completed = Some(completed(request, raw, selected, child.state.history)) };
}

flow run_mode(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool, private_progress: bool) -> TurnResult {
    let multi = unicode && (invocation.maximum == multi_maximum(2) || invocation.maximum == multi_maximum(32));
    let session = unicode && invocation.maximum == session_maximum();
    let extended = unicode && is_extended(invocation.maximum);
    let invalid = if multi { multi_turn_error(invocation, if invocation.maximum == multi_maximum(32) { 32 } else { 2 }) } else { if session { session_turn_error(invocation) } else { if extended { extended_turn_error(invocation) } else { if unicode { unicode_turn_error(invocation) } else { turn_error(invocation) } } } };
    if invalid != "" { println("REFUSED " + invalid); return TurnResult { status = 1, state = invocation, resolved = true, completed = None() }; }
    let last_admission = if multi && invocation.maximum == multi_maximum(32) { 31 } else { if session { 31 } else { if extended { 3 } else { 1 } } };
    if invocation.admitted < 0 || invocation.admitted > last_admission {
        println("REFUSED turn limit reached"); return TurnResult { status = 1, state = invocation, resolved = true, completed = None() };
    }
    let turn = invocation.admitted + 1;
    let local = execute(request, allowed, invocation.prior, invocation.usage, turn, unicode, private_progress, multi);
    if !local.resolved { return TurnResult { status = 1, state = invocation, resolved = false, completed = None() }; }
    let combined = if multi { multi_combine(invocation.usage, local.usage, invocation.maximum) } else { if session { session_combine(invocation.usage, local.usage) } else { if extended { extended_combine(invocation.usage, local.usage) } else { combine(invocation.usage, local.usage, invocation.maximum) } } };
    let usage = match combined {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return TurnResult { status = 1, state = invocation, resolved = false, completed = None() }; }
    };
    let next = Invocation { usage = usage, maximum = invocation.maximum, admitted = turn, prior = local.selected };
    return TurnResult { status = local.status, state = next, resolved = true, completed = local.completed };
}

// User-facing final answers are unchanged; progress omits arbitrary tool/task text.
public flow run_shared_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_mode(request, allowed, invocation, unicode, false);
}
public flow run_private_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_mode(request, allowed, invocation, unicode, true);
}
