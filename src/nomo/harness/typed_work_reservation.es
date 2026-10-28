module nomo.harness.typed_work_reservation;

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
    for value in [state.maximum, state.reserved, state.attempted] limit Iterations(3) {
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
    return Ok(Reservation { assumptions = policy, maximum = maximum, reserved = needed,
        attempted = prefix(0, policy.http_attempts), stages = 0, stopped = false });
}
// The caller must save this precharge before making the next one-infer stage.
public flow advance(state: Reservation) -> Result<Reservation, string> {
    let invalid = reservation_error(state); if invalid != "" { return Err(invalid); }
    if state.stopped || state.stages == 7 { return Err("typed reservation stopped or exhausted"); }
    return Ok(Reservation { assumptions = state.assumptions, maximum = state.maximum, reserved = state.reserved,
        attempted = prefix(state.stages + 1, state.assumptions.http_attempts), stages = state.stages + 1, stopped = false });
}
public flow stop(state: Reservation) -> Result<Reservation, string> {
    let invalid = reservation_error(state); if invalid != "" { return Err(invalid); }
    return Ok(Reservation { assumptions = state.assumptions, maximum = state.maximum, reserved = state.reserved,
        attempted = state.attempted, stages = state.stages, stopped = true });
}
