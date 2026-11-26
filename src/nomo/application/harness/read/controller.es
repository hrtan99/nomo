module nomo.application.harness.read.controller;

import std.text.from_i32;
import nomo.application.harness.read.ports.{Report, Failure, ReadContextValidation, ReadContextBudget, ReadContextProgress};
import nomo.core.conversation.Event;
import nomo.domain.conversation.state.add;
import nomo.domain.harness.model_tool_contract.fresh_loop;
import nomo.domain.harness.tool_context.allowed_error;
import nomo.domain.harness.harness_tool_contract.{Context, numbers};
import nomo.harness.harness_tool_contract.Ledger;
import nomo.application.harness.effects.harness_legacy_string_stages.LegacyStringStages;
import nomo.domain.harness.model_plan_diagnostic.{returned_text, response_text};
import nomo.application.harness.effects.model_harness_progress.HarnessProgress;

flow failed(state: Ledger, error: string, resolved: bool) -> Result<Report, Failure> {
    return Err(Failure { state, error, resolved });
}

// Reservation, observation and validation are shared by all stage handlers.
public flow run_context_policy<P ~ ReadContextValidation + ReadContextBudget + ReadContextProgress>(policy: P, request: string, allowed: Array<string>, initial: Ledger,
    prefix: string, require_tool: bool, inspect_plan: bool, inspect_all: bool) -> Result<Report, Failure> {
    var state = initial;
    let invalid = policy.request_error(request); if invalid != "" { return failed(state, invalid, true); }
    let invalid_allowed = allowed_error(allowed); if invalid_allowed != "" { return failed(state, invalid_allowed, true); }
    let plan = Context { phase = "plan", request, task = "", result = "", tool = "", outcome = "", allowed };
    let invalid_plan = policy.validate_context(plan); if invalid_plan != "" { return failed(state, invalid_plan, true); }
    state = match policy.reserve(state, true) { Ok(value) => value, Err(error) => { return failed(state, error, true); } };
    @limits([Iterations(2)]) for line in policy.progress("plan", state, prefix) { perform HarnessProgress.write(line); }
    let raw = perform LegacyStringStages.main(plan);
    if inspect_plan { perform HarnessProgress.write(returned_text(raw, "lab-qwen-")); }
    else if inspect_all { perform HarnessProgress.write(response_text(raw, "read-plan", "lab-qwen-", 384)); }
    let task = match policy.decode(raw) { Ok(value) => value, Err(error) => {
        let rejected = policy.rejection(raw, error);
        if rejected != "" { perform HarnessProgress.write(rejected); }
        return failed(state, error, true);
    } };
    if inspect_plan { return failed(state, "read-plan inspection complete; no child, File or edit attempted", true); }
    state = match policy.reserve(state, false) { Ok(value) => value, Err(error) => { return failed(state, error, true); } };
    perform HarnessProgress.write("EVENT main -> child-1 request child-1: " + task);
    let empty = fresh_loop();
    let selected = add(empty.history, Event { role = "user", kind = "context", name = "original", text = request });
    @limits([Iterations(2)]) for line in policy.progress("child", state, prefix) { perform HarnessProgress.write(line); }
    let child = perform LegacyStringStages.child(task, allowed, selected);
    let observed = match policy.observe_child(child, request, task, allowed) { Ok(value) => value, Err(error) => { return failed(state, error, false); } };
    state = match policy.settle_child(state, child.state) { Ok(value) => value, Err(error) => { return failed(state, error, false); } };
    let allowance = policy.allowance();
    perform HarnessProgress.write("SETTLED child-1 " + numbers(state) + " released_steps=" + from_i32(5 - state.steps) +
        " released_calls=" + from_i32(3 - state.calls) + " released_tokens=" + from_i32(allowance.tokens - state.tokens) +
        " released_tools=" + from_i32(1 - state.tools) + " released_scan=" + from_i32(allowance.scan - state.scan) + " unresolved=false");
    if child.status != 0 { return failed(state, "child returned failure; no aggregation", true); }
    if require_tool && child.state.tools != 1 { return failed(state, "work requires a successful read or search child", true); }
    let result_error = policy.result_error(observed.result); if result_error != "" { return failed(state, result_error, true); }
    perform HarnessProgress.write("EVENT child-1 -> main result child-1: " + observed.result);
    state = match policy.reserve(state, false) { Ok(value) => value, Err(error) => { return failed(state, error, true); } };
    perform HarnessProgress.write("EVENT main -> main consume child-1: " + observed.result);
    if observed.tool != "" { perform HarnessProgress.write("EVENT main -> main tool " + observed.tool + ": " + observed.outcome); }
    let aggregate = Context { phase = "aggregate", request, task, result = observed.result,
        tool = observed.tool, outcome = observed.outcome, allowed };
    let invalid_aggregate = policy.validate_context(aggregate); if invalid_aggregate != "" { return failed(state, invalid_aggregate, true); }
    state = match policy.reserve(state, true) { Ok(value) => value, Err(error) => { return failed(state, error, true); } };
    @limits([Iterations(2)]) for line in policy.progress("aggregate", state, prefix) { perform HarnessProgress.write(line); }
    let answer = perform LegacyStringStages.main(aggregate);
    if inspect_all { perform HarnessProgress.write(response_text(answer, "read-aggregate", "lab-qwen-", 512)); }
    let invalid_answer = policy.answer_error(answer);
    if invalid_answer != "" { return failed(state, invalid_answer, true); }
    return Ok(Report { request, task, allowed, child = child.state,
        status = child.status, observed, answer, ledger = state });
}
