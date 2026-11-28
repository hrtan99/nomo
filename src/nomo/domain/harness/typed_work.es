module nomo.domain.harness.typed_work;

import nomo.domain.editing.{Contribution, Proposal, project};
import nomo.domain.harness.edit.{text_error, work_summary_error};
import nomo.domain.harness.loop.{
    Action,
    Context as loop_Context,
    allowed_error,
    context_error as loop_context_error,
    question_error,
    read_selection_error
};
import nomo.domain.harness.read.{ReadContext, read_aggregate_error, read_context_error};
import nomo.domain.harness.work.{Context, Evidence, context_error, finish_evidence};
import nomo.domain.limits.{child_answer_bytes, message_bytes};
import nomo.domain.sessions.chain.Input;
import nomo.domain.text.bounded;

public flow input_error(context: Context) -> string {
    if context.edit.phase != "child" { return "typed edit pilot requires child context"; }
    return context_error(context);
}

// Pure proposal data is not current File observation, approval or a receipt.
// Existing confirmed apply/journal paths remain authoritative and unwired here.
public flow project_context(context: Context, value: Contribution) -> Result<Proposal, string> {
    let error = input_error(context); if error != "" { return Err(error); }
    return project(context.edit.path, context.edit.before, value);
}

public type Delegation = { task: string };

public type ReadAction = { operation: string, files: Array<string>, literal: string };

public type Answer = { text: string };

// ETAS 0.4.1 checks this typed design but cannot yet lower it to a host schema.
// Keep the formal contract while runtime action selection remains on the strict
// string decoder; see etas-project/etas#65.
public enum ChildSelection {
    Read(string),
    Search(string, Array<string>),
    Final(string),
}

public flow read_input_error(context: ReadContext, phase: string) -> string {
    if (phase != "plan" && phase != "aggregate") || context.phase != phase { return "typed read context phase mismatch"; }
    let request = question_error(context.request); if request != "" { return request; }
    let allowed = allowed_error(context.allowed); if allowed != "" { return allowed; }
    return read_context_error(context);
}

public flow child_input_error(context: loop_Context, final_only: bool) -> string {
    if context.final_only != final_only { return "typed child context phase mismatch"; }
    let allowed = allowed_error(context.allowed); if allowed != "" { return allowed; }
    return loop_context_error(context);
}

public flow edit_input_error(input: Input, phase: string) -> string {
    if (phase != "plan" && phase != "child" && phase != "aggregate") || input.current.edit.phase != phase {
        return "typed edit context phase mismatch";
    }
    return context_error(input.current);
}

public flow project_read_plan(context: ReadContext, value: Delegation) -> Result<string, string> {
    let invalid = read_input_error(context, "plan"); if invalid != "" { return Err(invalid); }
    if !bounded(value.task, message_bytes()) { return Err("invalid bounded delegated task"); }
    return Ok(value.task);
}

public flow project_read_action(context: loop_Context, value: ReadAction) -> Result<Action, string> {
    let invalid = child_input_error(context, false); if invalid != "" { return Err(invalid); }
    let selected = read_selection_error(value.operation, value.files, value.literal, context.allowed);
    if selected != "" { return Err(selected); }
    return Ok(Action { operation = value.operation, files = value.files, literal = value.literal, text = "" });
}

public flow project_read_final(context: loop_Context, value: Answer) -> Result<Action, string> {
    let invalid = child_input_error(context, true); if invalid != "" { return Err(invalid); }
    if !bounded(value.text, child_answer_bytes()) { return Err("invalid bounded child final answer"); }
    return Ok(Action { operation = "final", files = [], literal = "", text = value.text });
}

public flow project_read_aggregate(context: ReadContext, value: Answer) -> Result<string, string> {
    let invalid = read_input_error(context, "aggregate"); if invalid != "" { return Err(invalid); }
    let summary = read_aggregate_error(value.text); if summary != "" { return Err(summary); }
    return Ok(value.text);
}

// Preserve the controller-supplied actual selection, complete outcome and ledger.
// A typed summary cannot replace them or manufacture a successful tool result.
public flow settle_read(pending: Evidence, value: Answer) -> Result<Evidence, string> {
    let invalid = read_aggregate_error(value.text); if invalid != "" { return Err(invalid); }
    return finish_evidence(pending, value.text);
}

public flow project_edit_plan(input: Input, value: Delegation) -> Result<string, string> {
    let invalid = edit_input_error(input, "plan"); if invalid != "" { return Err(invalid); }
    let task = text_error(value.task, "delegated task"); if task != "" { return Err(task); }
    return Ok(value.task);
}

public flow project_edit_child(input: Input, value: Contribution) -> Result<Proposal, string> {
    let invalid = edit_input_error(input, "child"); if invalid != "" { return Err(invalid); }
    return project_context(input.current, value);
}

public flow project_edit_aggregate(input: Input, value: Answer) -> Result<string, string> {
    let invalid = edit_input_error(input, "aggregate"); if invalid != "" { return Err(invalid); }
    let summary = work_summary_error(value.text); if summary != "" { return Err(summary); }
    return Ok(value.text);
}

// Independent application envelopes, not native controls, measured usage,
// durable admission or a promise of external cost. Nothing wires these to v2.
public type Policy = { repair_rounds: i32, http_attempts: i32 };

public type Envelope = { logical: i32, native_requests: i32, http_attempts: i32, generation: i32 };

public type Reservation = { assumptions: Policy, maximum: Envelope, reserved: Envelope, attempted: Envelope, stages: i32, stopped: bool };

flow policy_error(policy: Policy) -> string {
    if policy.repair_rounds != 8 || policy.http_attempts < 1 || policy.http_attempts > 3 {
        return "unsupported typed repair/HTTP policy";
    }
    return "";
}

flow envelope_error(value: Envelope) -> string {
    if value.logical < 0 || value.logical > 7 || value.native_requests < 0 || value.native_requests > 63 ||
        value.http_attempts < 0 || value.http_attempts > 189 || value.generation < 0 || value.generation > 423936 {
        return "invalid typed reservation envelope";
    }
    return "";
}

flow prefix(stages: i32, attempts: i32) -> Envelope {
    let generation: i32 = match stages { 0 => 0, 1 => 2048, 2 => 4096, 3 => 6144, 4 => 8192, 5 => 12288, 6 => 45056, _ => 47104 };
    return Envelope { logical = stages, native_requests = stages * 9, http_attempts = stages * 9 * attempts, generation = generation * 9 };
}

public flow required(policy: Policy) -> Result<Envelope, string> {
    let invalid = policy_error(policy); if invalid != "" { return Err(invalid); }
    return Ok(prefix(7, policy.http_attempts));
}

flow fits(maximum: Envelope, needed: Envelope) -> bool {
    return maximum.logical >= needed.logical && maximum.native_requests >= needed.native_requests &&
        maximum.http_attempts >= needed.http_attempts && maximum.generation >= needed.generation;
}

public flow reservation_error(state: Reservation) -> string {
    let invalid = policy_error(state.assumptions); if invalid != "" { return invalid; }
    if state.stages < 0 || state.stages > 7 { return "invalid typed reservation stage"; }
    @limits([Iterations(3)]) for value in [state.maximum, state.reserved, state.attempted] {
        let error = envelope_error(value); if error != "" { return error; }
    }
    // Every operand is bounded before multiplication or comparison below.
    let needed = prefix(7, state.assumptions.http_attempts);
    if !fits(state.maximum, needed) { return "typed reservation exhausted"; }
    if state.reserved != needed || state.attempted != prefix(state.stages, state.assumptions.http_attempts) {
        return "typed reservation counters changed";
    }
    return "";
}

// Hold the entire seven-stage envelope from the start. A failed or uncertain
// attempt never frees this value; stopping cannot refund or restart it.
public flow admit(policy: Policy, maximum: Envelope) -> Result<Reservation, string> {
    let needed = match required(policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let invalid = envelope_error(maximum); if invalid != "" { return Err(invalid); }
    if !fits(maximum, needed) { return Err("typed reservation exhausted"); }
    return Ok(Reservation { assumptions = policy, maximum, reserved = needed,
        attempted = prefix(0, policy.http_attempts), stages = 0, stopped = false });
}

// The caller must save this precharge before making the next one-infer stage.
public flow advance(state: Reservation) -> Result<Reservation, string> {
    let invalid = reservation_error(state); if invalid != "" { return Err(invalid); }
    if state.stopped || state.stages == 7 { return Err("typed reservation stopped or exhausted"); }
    return Ok(state { attempted = prefix(state.stages + 1, state.assumptions.http_attempts), stages = state.stages + 1, stopped = false });
}

public flow stop(state: Reservation) -> Result<Reservation, string> {
    let invalid = reservation_error(state); if invalid != "" { return Err(invalid); }
    return Ok(state { stopped = true });
}
