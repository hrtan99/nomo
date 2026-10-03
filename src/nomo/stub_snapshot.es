module nomo.stub_snapshot;

import std.collections.len as count;
import std.text.to_string_usize;
import nomo.conversation.State;
import nomo.session_state.{Caps, Ledger, Operation, Reference, Snapshot, Request, validate};

public flow caps(maximum: i32, budget: i32) -> Caps {
    return Caps { steps = budget, turn_steps = maximum, attempts = 0, tokens = 0, scan_bytes = 0 };
}

// Map observed application data only. An error after a request is not evidence
// that the requested tool ran, and never becomes a fabricated completed outcome.
public flow snapshot(state: State, id: string, binding: string, maximum: i32, budget: i32) -> Result<Snapshot, string> {
    if count(state.events) > 32 { return Err("stub event count exceeds limit"); }
    var operations: Array<Operation> = [];
    var references: Array<Reference> = [];
    var unresolved = false;
    var index: usize = 0;
    for event in state.events limit Iterations(32) {
        if event.role == "model" && event.kind == "request" {
            let operation = "stub-request-" + to_string_usize(index);
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
            references = references.push(Reference { operation = "stub-request-" + to_string_usize(index - 1), phase = "outcome" });
        } else {
            references = references.push(Reference { operation = "", phase = "" });
        }
        index = index + 1;
    }
    let limits = caps(maximum, budget);
    var lifecycle = "active";
    if unresolved { lifecycle = "recovery-required"; }
    else if state.stopped { lifecycle = "stopped"; }
    let saved = Snapshot { format = 1, session_id = id, generation = 0, mode = "stub", binding = binding,
        lifecycle = lifecycle, history = state, references = references, operations = operations,
        original_caps = limits, current_caps = limits,
        ledger = Ledger { attempts = 0, tokens = 0, scan_bytes = 0, step_unit = "steps", attempt_unit = "attempts",
            token_unit = "total-input-output-tokens", scan_unit = "bytes" } };
    let requested = Request { session_id = id, mode = "stub", binding = binding, caps = limits };
    // Validation may project stopped/recovery-required; preserve the actual State.
    return match validate(saved, requested) { Ok(_) => Ok(saved), Err(error) => Err(error) };
}
