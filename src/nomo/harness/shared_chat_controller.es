module nomo.harness.shared_chat_controller;

import nomo.model.harness_progress.{HarnessProgress, ProgressSink};
import nomo.model.conversation_output.{ConversationOutput, ConversationSink};
import nomo.agent.console_progress.ConsoleProgress;
import nomo.agent.console_events.{PublicHarnessEvents, RedactedHarnessEvents};
import std.text.from_i32;
import nomo.core.conversation.{Event, State};
import nomo.model.model_tool_contract.{question_error, allowed_error, candidate_error};
import nomo.harness.harness_model_contract.{bounded, decode_plan};
import nomo.harness.harness_tool_contract.{Ledger, fresh, numbers};
import nomo.harness.chat_budget_policy.{ChatBudgetPolicy, SelectedBudget, select};
import nomo.harness.harness_tool_chat_contract.{Previous, Context, Invocation, LocalTurn, TurnResult, Completed, empty,
    context_error, seed, inspect_turn, combine};
import nomo.harness.legacy_chat_stages.LegacyChatStages;
import nomo.model.read_protocol.question_error as unicode_question_error;
import nomo.model.read_protocol.decode_work_plan as unicode_decode_plan;
import nomo.core.read_text.bounded as unicode_bounded;

import nomo.harness.read_tool_chat_contract.context_error as unicode_context_error;
import nomo.harness.read_tool_chat_contract.{inspect_turn as unicode_inspect_turn, inspect_multi_turn};


flow refused(usage: Ledger, error: string, resolved: bool) -> LocalTurn {
    perform HarnessProgress.write("REFUSED " + error);
    if !resolved { perform HarnessProgress.write("RESERVATION child-1 unresolved=true; returned child metadata refused"); }
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

flow stage<P ~ ChatBudgetPolicy>(policy: P, turn: i32, phase: string, before: Ledger, local: Ledger) -> unit {
    let pending = policy.pending(phase);
    perform HarnessProgress.write("TURN " + from_i32(turn) + " STAGE " + phase + " " + numbers(total(before, local)) +
        " reserved_steps=" + from_i32(pending.steps) + " reserved_calls=" + from_i32(pending.calls) +
        " reserved_tokens=" + from_i32(pending.tokens) + " reserved_tools=" + from_i32(pending.tools) +
        " reserved_scan=" + from_i32(pending.scan));
    if phase == "child" {
        perform HarnessProgress.write("RESERVATION child-1 " + numbers(policy.child_pending()) + " tail_steps=2 tail_calls=1 tail_tokens=" + from_i32(policy.parent_tokens()) + " unresolved=true");
    }
}

// The invocation supplies cumulative usage and a validated successful selection.
// Fresh local counters are a subledger of the already checked global reservation.
flow execute<P ~ ChatBudgetPolicy>(policy: P, request: string, allowed: Array<string>, prior: Previous, before: Ledger, turn: i32, unicode: bool, multi: bool) -> LocalTurn {
    var state = fresh();
    let invalid = if unicode { unicode_question_error(request) } else { question_error(request) }; if invalid != "" { return refused(state, invalid, true); }
    let paths = if unicode { candidate_error(allowed) } else { allowed_error(allowed) }; if paths != "" { return refused(state, paths, true); }
    let plan = Context { phase = "plan", request = request, task = "", result = "", tool = "", outcome = "", allowed = allowed, prior = prior };
    let invalid_plan = if unicode { unicode_context_error(plan) } else { context_error(plan) }; if invalid_plan != "" { return refused(state, invalid_plan, true); }
    state = match policy.reserve_stage(state, true) { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    stage(policy, turn, "plan", before, state);
    let raw = perform LegacyChatStages.main(plan);
    let decoded = if unicode { unicode_decode_plan(raw) } else { decode_plan(raw) };
    let task = match decoded { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    state = match policy.reserve_stage(state, false) { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    perform ConversationOutput.publish(Event { role = "main -> child-1", kind = "request", name = "child-1", text = task });
    stage(policy, turn, "child", before, state);
    let child = perform LegacyChatStages.child(task, allowed, seed(request, prior), multi, policy.resilient_child());
    let inspected = if multi { inspect_multi_turn(child.state, child.status, request, task, allowed, prior) } else { if unicode { unicode_inspect_turn(child.state, child.status, request, task, allowed, prior) }
        else { inspect_turn(child.state, child.status, request, task, allowed, prior) } };
    let observed = match inspected {
        Ok(value) => value, Err(error) => { return refused(state, error, false); }
    };
    if child.state.calls != 0 {
        state = match policy.settle_child(state, child.state) { Ok(value) => value, Err(error) => { return refused(state, error, false); } };
    }
    let pending = policy.pending("child");
    perform HarnessProgress.write("SETTLED child-1 " + numbers(total(before, state)) + " released_steps=" + from_i32(pending.steps - state.steps) +
        " released_calls=" + from_i32(pending.calls - state.calls) + " released_tokens=" + from_i32(pending.tokens - state.tokens) +
        " released_tools=" + from_i32(pending.tools - state.tools) + " released_scan=" + from_i32(pending.scan - state.scan) + " unresolved=false");
    if child.status != 0 { return refused(state, "child returned failure; no aggregation", true); }
    if !(if unicode { unicode_bounded(observed.result, 256) } else { bounded(observed.result, 256) }) { return refused(state, "invalid bounded child result", true); }
    perform ConversationOutput.publish(Event { role = "child-1 -> main", kind = "result", name = "child-1", text = observed.result });
    state = match policy.reserve_stage(state, false) { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    perform ConversationOutput.publish(Event { role = "main -> main", kind = "consume", name = "child-1", text = observed.result });
    if observed.tool != "" {
        perform ConversationOutput.publish(Event { role = "main -> main", kind = "tool", name = observed.tool, text = observed.outcome });
    }
    let aggregate = Context { phase = "aggregate", request = request, task = task, result = observed.result,
        tool = observed.tool, outcome = observed.outcome, allowed = allowed, prior = prior };
    let invalid_aggregate = if unicode { unicode_context_error(aggregate) } else { context_error(aggregate) }; if invalid_aggregate != "" { return refused(state, invalid_aggregate, true); }
    state = match policy.reserve_stage(state, true) { Ok(value) => value, Err(error) => { return refused(state, error, true); } };
    stage(policy, turn, "aggregate", before, state);
    let answer = perform LegacyChatStages.main(aggregate);
    if !(if unicode { unicode_bounded(answer, 512) } else { bounded(answer, 512) }) { return refused(state, "invalid bounded final answer", true); }
    perform HarnessProgress.write("FINAL " + answer);
    let selected = Previous { task = task, result = observed.result, tool = observed.tool, outcome = observed.outcome, answer = answer };
    return LocalTurn { status = 0, usage = state, selected = selected, resolved = true,
        completed = Some(completed(request, raw, selected, child.state.history)) };
}

flow run_policy<P ~ ChatBudgetPolicy>(policy: P, request: string, allowed: Array<string>, invocation: Invocation, unicode: bool, multi: bool) -> TurnResult {
    let invalid = policy.validate_invocation(invocation);
    if invalid != "" { perform HarnessProgress.write("REFUSED " + invalid); return TurnResult { status = 1, state = invocation, resolved = true, completed = None() }; }
    let last_admission = policy.turn_limit() - 1;
    if invocation.admitted < 0 || invocation.admitted > last_admission {
        perform HarnessProgress.write("REFUSED turn limit reached"); return TurnResult { status = 1, state = invocation, resolved = true, completed = None() };
    }
    let turn = invocation.admitted + 1;
    let local = execute(policy, request, allowed, invocation.prior, invocation.usage, turn, unicode, multi);
    if !local.resolved { return TurnResult { status = 1, state = invocation, resolved = false, completed = None() }; }
    let combined = policy.combine(invocation.usage, local.usage);
    let usage = match combined {
        Ok(value) => value, Err(error) => { perform HarnessProgress.write("REFUSED " + error); return TurnResult { status = 1, state = invocation, resolved = false, completed = None() }; }
    };
    let next = Invocation { usage = usage, maximum = invocation.maximum, admitted = turn, prior = local.selected };
    return TurnResult { status = local.status, state = next, resolved = true, completed = local.completed };
}

flow run_mode(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return match select(invocation, unicode) {
        SelectedBudget.Single(policy) => run_policy(policy, request, allowed, invocation, unicode, false),
        SelectedBudget.Multi(policy) => run_policy(policy, request, allowed, invocation, unicode, true),
    };
}

// User-facing final answers are unchanged; progress omits arbitrary tool/task text.
public flow run_shared_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_output(PublicHarnessEvents {}, request, allowed, invocation, unicode);
}
public flow run_private_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_output(RedactedHarnessEvents {}, request, allowed, invocation, unicode);
}

flow run_output<S ~ ConversationSink>(sink: S, request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    let progress = ConsoleProgress {};
    return run_mode(request, allowed, invocation, unicode) with {
        ConversationOutput.publish(event) => { resume sink.publish(event); }
        HarnessProgress.write(line) => { resume progress.write(line); }
    };
}
