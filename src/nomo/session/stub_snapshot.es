module nomo.session.stub_snapshot;

import std.collections.len as count;
import std.text.to_string_usize;
import nomo.core.conversation.{State, fresh, stop};
import nomo.session.session_state.{Caps, Ledger, Operation, Reference, Snapshot, Request, Projection, validate};

public flow caps(maximum: i32, budget: i32) -> Caps {
    return Caps { steps = budget, turn_steps = maximum, attempts = 0, tokens = 0, scan_bytes = 0 };
}

// Map observed application data only. An error after a request is not evidence
// that the requested tool ran, and never becomes a fabricated completed outcome.
flow mapped(state: State, seed: Snapshot, prefix: usize) -> Result<Snapshot, string> {
    if count(state.events) > 32 { return Err("stub event count exceeds limit"); }
    if count(state.events) < prefix { return Err("stub predecessor prefix missing"); }
    var operations = seed.operations;
    var references = seed.references;
    var unresolved = false;
    var index: usize = 0;
    for event in state.events limit Iterations(32) {
        if index < prefix {
            if event != seed.history.events[index] { return Err("stub predecessor prefix changed"); }
        } else if event.role == "model" && event.kind == "request" {
            let operation = if seed.generation == 0 { "stub-request-" + to_string_usize(index) }
                else { "stub-successor-request-" + to_string_usize(index) };
            var status = "pending";
            if index + 1 < count(state.events) {
                let next = state.events[index + 1];
                if next.role == "tool" && next.name == event.name && (next.kind == "complete" || next.kind == "error") {
                    status = "completed";
                }
            }
            if status == "pending" { unresolved = true; }
            operations = operations.push(Operation { id = operation, status = status, attempts = 0, tokens = 0, scan_bytes = 0 });
            references = references.push(Reference { operation = operation, phase = "request" });
        } else if event.role == "tool" {
            if index == 0 { return Err("stub tool outcome has no request"); }
            let prior = state.events[index - 1];
            if prior.role != "model" || prior.kind != "request" || prior.name != event.name {
                return Err("stub tool outcome has no matching request");
            }
            references = references.push(Reference { operation = references[index - 1].operation, phase = "outcome" });
        } else {
            references = references.push(Reference { operation = "", phase = "" });
        }
        index = index + 1;
    }
    var lifecycle = "active";
    if unresolved { lifecycle = "recovery-required"; }
    else if state.stopped { lifecycle = "stopped"; }
    let saved = Snapshot { format = 1, session_id = seed.session_id, generation = seed.generation, mode = "stub", binding = seed.binding,
        lifecycle = lifecycle, history = state, references = references, operations = operations,
        original_caps = seed.original_caps, current_caps = seed.current_caps, ledger = seed.ledger };
    let requested = Request { session_id = seed.session_id, mode = "stub", binding = seed.binding, caps = seed.current_caps };
    // Validation may project stopped/recovery-required; preserve the actual State.
    return match validate(saved, requested) { Ok(_) => Ok(saved), Err(error) => Err(error) };
}

public flow snapshot(state: State, id: string, binding: string, maximum: i32, budget: i32) -> Result<Snapshot, string> {
    let limits = caps(maximum, budget);
    let seed = Snapshot { format = 1, session_id = id, generation = 0, mode = "stub", binding = binding,
        lifecycle = "active", history = fresh(), references = [], operations = [], original_caps = limits, current_caps = limits,
        ledger = Ledger { attempts = 0, tokens = 0, scan_bytes = 0, step_unit = "steps", attempt_unit = "attempts",
            token_unit = "total-input-output-tokens", scan_unit = "bytes" } };
    return mapped(state, seed, 0);
}

// Only an observed source-returned turn can settle the absolute admission bound.
public flow successor(state: State, prior: Projection, reserved: i32, status: i32) -> Result<Snapshot, string> {
    if prior.mode != "stub" || prior.generation != 0 || prior.disposition != "validated" || prior.history.stopped ||
        state.spent < prior.history.spent || state.spent > reserved || reserved > prior.caps.steps {
        return Err("invalid stub settlement");
    }
    let observed = if status == 4 || state.spent >= prior.caps.steps { stop(state) } else { state };
    let seed = Snapshot { format = 1, session_id = prior.session_id, generation = 1, mode = prior.mode, binding = prior.binding,
        lifecycle = "active", history = prior.history, references = prior.references, operations = prior.operations,
        original_caps = prior.original_caps, current_caps = prior.caps, ledger = prior.ledger };
    return mapped(observed, seed, count(prior.history.events));
}
