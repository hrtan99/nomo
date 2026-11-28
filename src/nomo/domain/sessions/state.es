module nomo.domain.sessions.state;

import nomo.core.conversation.{Event, State};
import nomo.domain.conversation.{capacity_error, fresh, stop};
import nomo.domain.limits.{event_bytes, history_bytes};
import nomo.domain.sessions.event_codec.Bundle;
import nomo.domain.text.{input_error, text_printable};
import nomo.session.session_state.{Caps, Ledger, Operation, Reference, Snapshot};
import nomo.session.store_record.Record;
import std.collections.Map;
import std.text.{char_count, from_usize, trim};

public type Admission = { prior: Projection, reserved: i32 };

public flow plan(saved: Snapshot, requested: Request, generation: i32, input: string) -> Result<Admission, string> {
    let prior = match validate(saved, requested) { Ok(value) => value, Err(error) => { return Err(error); } };
    if generation != 0 || prior.generation != generation || prior.mode != "stub" { return Err("unsupported or stale checkpoint generation"); }
    if prior.disposition != "validated" || prior.history.stopped { return Err("session stopped or recovery required; no continuation"); }
    let invalid = input_error(input);
    if invalid != "" { return Err(invalid); }
    let size = char_count(trim(input));
    var characters = 4 * size + 32;
    if characters < size + 1040 { characters = size + 1040; }
    let full = capacity_error(prior.history, 4, characters);
    if full != "" { return Err(full); }
    // validate bounded all counters first. These subtractions/additions cannot overflow.
    var bound = prior.caps.steps - prior.history.spent;
    if bound > prior.caps.turn_steps { bound = prior.caps.turn_steps; }
    if bound > 3 { bound = 3; }
    if bound <= 0 { return Err("session step budget exhausted"); }
    return Ok(Admission { prior, reserved = prior.history.spent + bound });
}

// Same typed record shape, explicit non-checkpoint phase. The immutable demo claim
// binds the predecessor ID; this row binds generation 0 and the distinct next key.
// Reserved spending is a high-water mark, never measured completed work.
public flow continuing(admitted: Admission, next_save: string) -> Record {
    let prior = admitted.prior;
    let reserved = Snapshot { format = 1, session_id = prior.session_id, generation = prior.generation,
        mode = prior.mode, binding = prior.binding, lifecycle = "recovery-required",
        history = prior.history { spent = admitted.reserved, stopped = true },
        references = prior.references, operations = prior.operations, original_caps = prior.original_caps,
        current_caps = prior.caps, ledger = prior.ledger };
    let row = pending(reserved, next_save);
    return row { phase = "continuing" };
}

public type Request = { session_id: string, mode: string, binding: string, caps: Caps };

public type Projection = {
    session_id: string, generation: i32, mode: string, binding: string,
    disposition: string, history: State, references: Array<Reference>,
    operations: Array<Operation>, original_caps: Caps, caps: Caps, ledger: Ledger
};

flow identifier(value: string) -> bool {
    if char_count(value) == 0 || char_count(value) > 128 { return false; }
    return text_printable(value);
}

flow valid_caps(caps: Caps, mode: string) -> bool {
    if caps.steps < 1 || caps.steps > 16 || caps.turn_steps < 1 || caps.turn_steps > 16 { return false; }
    if mode == "stub" { return caps.attempts == 0 && caps.tokens == 0 && caps.scan_bytes == 0; }
    if mode == "text-model" {
        return caps.attempts >= 0 && caps.attempts <= 4 && caps.tokens >= 0 && caps.tokens <= 8192 && caps.scan_bytes == 0;
    }
    return caps.attempts == 0 && caps.tokens == 0 && caps.scan_bytes >= 0 && caps.scan_bytes <= 8192;
}

flow minimum(a: i32, b: i32) -> i32 {
    if a < b { return a; }
    return b;
}

flow constrain(a: Caps, b: Caps) -> Caps {
    return Caps { steps = minimum(a.steps, b.steps), turn_steps = minimum(a.turn_steps, b.turn_steps),
        attempts = minimum(a.attempts, b.attempts), tokens = minimum(a.tokens, b.tokens), scan_bytes = minimum(a.scan_bytes, b.scan_bytes) };
}

flow event_valid(event: Event, mode: string) -> bool {
    if char_count(event.role) > 128 || char_count(event.kind) > 128 || char_count(event.name) > 128 { return false; }
    if !text_printable(event.name) { return false; }
    if event.role == "user" { return event.kind == "input" && event.name == ""; }
    if event.role == "assistant" { return event.kind == "final" && event.name == ""; }
    if event.role == "error" { return event.kind == "error" && event.name == ""; }
    if event.role == "model" {
        if mode == "text-model" { return event.kind == "text" && event.name == "qwen"; }
        return event.kind == "request" && identifier(event.name);
    }
    return mode != "text-model" && event.role == "tool" &&
        (event.kind == "complete" || event.kind == "error") && identifier(event.name);
}

// All diagnostics are fixed strings; no supplied identifier/content is echoed.
public flow validate(saved: Snapshot, requested: Request) -> Result<Projection, string> {
    if saved.format != 1 { return Err("unsupported session format"); }
    if saved.mode != "stub" && saved.mode != "text-model" && saved.mode != "scripted-read" {
        return Err("unsupported session mode");
    }
    if saved.mode != requested.mode { return Err("session mode mismatch"); }
    if !identifier(saved.session_id) || !identifier(requested.session_id) || saved.session_id != requested.session_id {
        return Err("session identifier mismatch or invalid");
    }
    if !identifier(saved.binding) || !identifier(requested.binding) || saved.binding != requested.binding {
        return Err("missing or mismatched binding evidence");
    }
    if saved.generation < 0 { return Err("invalid logical generation"); }
    if saved.lifecycle != "active" && saved.lifecycle != "stopped" && saved.lifecycle != "recovery-required" {
        return Err("invalid session lifecycle");
    }
    if (saved.lifecycle == "active" && saved.history.stopped) || (saved.lifecycle == "stopped" && !saved.history.stopped) {
        return Err("lifecycle and stopped flag disagree");
    }
    if !valid_caps(saved.original_caps, saved.mode) || !valid_caps(saved.current_caps, saved.mode) || !valid_caps(requested.caps, saved.mode) {
        return Err("invalid mode-specific caps");
    }
    if saved.current_caps.steps > saved.original_caps.steps || saved.current_caps.turn_steps > saved.original_caps.turn_steps ||
        saved.current_caps.attempts > saved.original_caps.attempts || saved.current_caps.tokens > saved.original_caps.tokens ||
        saved.current_caps.scan_bytes > saved.original_caps.scan_bytes {
        return Err("saved caps exceed original caps");
    }
    let ledger = saved.ledger;
    if ledger.step_unit != "steps" || ledger.attempt_unit != "attempts" ||
        ledger.token_unit != "total-input-output-tokens" || ledger.scan_unit != "bytes" {
        return Err("invalid budget units");
    }
    // Bound every counter before multiplication/addition; never infer steps from events.
    if saved.history.spent < 0 || saved.history.spent > saved.original_caps.steps ||
        ledger.attempts < 0 || ledger.attempts > saved.original_caps.attempts ||
        ledger.tokens < 0 || ledger.tokens > saved.original_caps.tokens ||
        ledger.scan_bytes < 0 || ledger.scan_bytes > saved.original_caps.scan_bytes {
        return Err("invalid saved counters");
    }
    if saved.mode == "text-model" && (saved.history.spent != ledger.attempts || ledger.tokens != ledger.attempts * 2048) {
        return Err("model reservation mismatch");
    }
    if saved.history.events.len() > 32 || saved.references.len() != saved.history.events.len() || saved.operations.len() > 32 {
        return Err("event or operation count invalid");
    }
    if saved.history.characters > history_bytes() { return Err("history content capacity exceeded"); }
    var characters: usize = 0;
    @limits([Iterations(32)]) for event in saved.history.events {
        if !event_valid(event, saved.mode) { return Err("invalid event metadata"); }
        if char_count(event.text) > event_bytes() { return Err("history content capacity exceeded"); }
        characters = characters + char_count(event.name) + char_count(event.text);
        if characters > history_bytes() { return Err("history content capacity exceeded"); }
    }
    if characters != saved.history.characters { return Err("cached character count mismatch"); }
    if !saved.history.stopped && (saved.history.events.len() > 31 || characters > history_bytes() - 64) {
        return Err("missing terminal headroom");
    }
    var attempts: i32 = 0;
    var tokens: i32 = 0;
    var scan_bytes: i32 = 0;
    var unresolved = saved.lifecycle == "recovery-required";
    var ids: Map<string, usize> = {};
    for (index, operation) in saved.operations.iter().enumerate() {
        if !identifier(operation.id) { return Err("invalid operation identifier"); }
        if ids.contains_key(operation.id) { return Err("duplicate operation identifier"); }
        ids = ids.insert(operation.id, index);
        if operation.status != "completed" && operation.status != "pending" && operation.status != "unknown" {
            return Err("invalid operation status");
        }
        if operation.status != "completed" { unresolved = true; }
        if saved.mode == "text-model" {
            if operation.attempts != 1 || operation.tokens != 2048 || operation.scan_bytes != 0 {
                return Err("invalid model operation reservation");
            }
        } else {
            if operation.attempts != 0 || operation.tokens != 0 { return Err("cross-mode operation reservation"); }
            if saved.mode == "stub" && operation.scan_bytes != 0 { return Err("cross-mode operation reservation"); }
            if saved.mode == "scripted-read" && operation.scan_bytes != 4096 { return Err("invalid scan reservation"); }
        }
        attempts = attempts + operation.attempts;
        tokens = tokens + operation.tokens;
        scan_bytes = scan_bytes + operation.scan_bytes;
    }
    if attempts != ledger.attempts || tokens != ledger.tokens || scan_bytes != ledger.scan_bytes {
        return Err("operation ledger mismatch");
    }
    // References follow operation order, with at most one request/outcome each.
    var last_operation: usize = 0;
    var event_index: usize = 0;
    @limits([Iterations(32)]) for reference in saved.references {
        let event = saved.history.events[event_index];
        event_index = event_index + 1;
        if reference.operation == "" {
            if reference.phase != "" || event.role == "model" || event.role == "tool" ||
                (saved.mode == "text-model" && event.role == "assistant") {
                return Err("missing operation reference");
            }
        } else {
            if !identifier(reference.operation) { return Err("invalid operation reference"); }
            let index = match ids.get(reference.operation) {
                Some(value) => value, None() => { return Err("dangling operation reference"); }
            };
            if index < last_operation { return Err("operation references out of order"); }
            last_operation = index;
            if reference.phase == "request" {
                if event.role != "model" { return Err("contradictory request reference"); }
            } else {
                if reference.phase != "outcome" || (event.role != "tool" && event.role != "error" &&
                    !(saved.mode == "text-model" && event.role == "assistant")) {
                    return Err("contradictory outcome reference");
                }
            }
        }
    }
    var required_steps: i32 = 0;
    @limits([Iterations(32)]) for operation in saved.operations {
        var requests: i32 = 0;
        var outcomes: i32 = 0;
        var tool_outcomes: i32 = 0;
        var request_name = "";
        var index: usize = 0;
        @limits([Iterations(32)]) for reference in saved.references {
            let event = saved.history.events[index];
            index = index + 1;
            if reference.operation == operation.id {
                if reference.phase == "request" {
                    if outcomes != 0 { return Err("request follows outcome"); }
                    requests = requests + 1;
                    request_name = event.name;
                } else {
                    outcomes = outcomes + 1;
                    if event.role == "tool" { tool_outcomes = tool_outcomes + 1; }
                    if event.role == "tool" && (requests != 1 || event.name != request_name) {
                        return Err("tool outcome does not match request");
                    }
                }
            }
        }
        if requests > 1 || outcomes > 1 || (operation.status == "completed" && outcomes != 1) ||
            (operation.status != "completed" && outcomes != 0) {
            return Err("operation status and events disagree");
        }
        if saved.mode != "scripted-read" && operation.status == "completed" && requests != 1 {
            return Err("completed operation missing request");
        }
        // Scripted reads reserve before input validation; a completed preflight error
        // can have no request/charged step. No outcome means uncertainty, not refund.
        required_steps = required_steps + requests;
        required_steps = required_steps + tool_outcomes;
    }
    if required_steps > saved.history.spent { return Err("operation step counter mismatch"); }
    let caps = constrain(saved.current_caps, requested.caps);
    var stopped = saved.history.stopped || unresolved || saved.history.spent >= caps.steps;
    if saved.mode == "text-model" && (ledger.attempts >= caps.attempts || ledger.tokens + 2048 > caps.tokens) { stopped = true; }
    if saved.mode == "scripted-read" && ledger.scan_bytes + 4096 > caps.scan_bytes { stopped = true; }
    var disposition = "validated";
    if unresolved { disposition = "recovery-required"; }
    return Ok(Projection { session_id = saved.session_id, generation = saved.generation, mode = saved.mode,
        binding = saved.binding, disposition,
        history = saved.history { characters, stopped },
        references = saved.references, operations = saved.operations, original_caps = saved.original_caps,
        caps, ledger });
}

public flow valid_id(value: string) -> bool {
    if char_count(value) == 0 || char_count(value) > 128 { return false; }
    return text_printable(value);
}

public flow session_key(id: string, save_id: string) -> string {
    // Length prefixes make pairs unambiguous even when IDs contain delimiters.
    return "nomo-store-v1:" + std.text.from_usize(char_count(id)) + ":" + id + save_id;
}

public flow with_events(saved: Snapshot, events: Array<Event>) -> Snapshot {
    return saved { history = saved.history { events } };
}

public flow pending(saved: Snapshot, save_id: string) -> Record {
    let descriptors = saved.history.events.iter().map(event => event { text = "" }).collect();
    return Record { format = 1, phase = "pending", save_id,
        session_key = session_key(saved.session_id, save_id), snapshot = with_events(saved, descriptors) };
}

public flow published(row: Record) -> Record {
    return row { phase = "published" };
}

public flow bundle(saved: Snapshot, save_id: string) -> Bundle {
    let bodies = saved.history.events.iter().map(event => event.text).collect();
    return Bundle { format = 1, session_id = saved.session_id, save_id, bodies };
}

public flow restore(row: Record, body: Bundle) -> Result<Snapshot, string> {
    if row.format != 1 || (row.phase != "pending" && row.phase != "published") { return Err("invalid metadata format or phase"); }
    if !valid_id(row.save_id) || !valid_id(row.snapshot.session_id) { return Err("invalid metadata identity"); }
    if row.session_key != session_key(row.snapshot.session_id, row.save_id) || body.format != 1 ||
        body.session_id != row.snapshot.session_id || body.save_id != row.save_id { return Err("bundle identity mismatch"); }
    let saved = row.snapshot;
    if body.bodies.len() > 32 || saved.history.events.len() != body.bodies.len() ||
        saved.references.len() != body.bodies.len() || saved.operations.len() > 32 { return Err("bundle descriptor count mismatch"); }
    var events: Array<Event> = [];
    var index: usize = 0;
    @limits([Iterations(32)]) for descriptor in saved.history.events {
        if descriptor.text != "" { return Err("metadata contains duplicate event body"); }
        events = events.push(descriptor { text = body.bodies[index] });
        index = index + 1;
    }
    return Ok(with_events(saved, events));
}

public flow caps(maximum: i32, budget: i32) -> Caps {
    return Caps { steps = budget, turn_steps = maximum, attempts = 0, tokens = 0, scan_bytes = 0 };
}

// Map observed application data only. An error after a request is not evidence
// that the requested tool ran, and never becomes a fabricated completed outcome.
flow mapped(state: State, seed: Snapshot, prefix: usize) -> Result<Snapshot, string> {
    if state.events.len() > 32 { return Err("stub event count exceeds limit"); }
    if state.events.len() < prefix { return Err("stub predecessor prefix missing"); }
    var operations = seed.operations;
    var references = seed.references;
    var unresolved = false;
    var index: usize = 0;
    @limits([Iterations(32)]) for event in state.events {
        if index < prefix {
            if event != seed.history.events[index] { return Err("stub predecessor prefix changed"); }
        } else if event.role == "model" && event.kind == "request" {
            let operation = if seed.generation == 0 { "stub-request-" + from_usize(index) }
                else { "stub-successor-request-" + from_usize(index) };
            var status = "pending";
            if index + 1 < state.events.len() {
                let next = state.events[index + 1];
                if next.role == "tool" && next.name == event.name && (next.kind == "complete" || next.kind == "error") {
                    status = "completed";
                }
            }
            if status == "pending" { unresolved = true; }
            operations = operations.push(Operation { id = operation, status, attempts = 0, tokens = 0, scan_bytes = 0 });
            references = references.push(Reference { operation, phase = "request" });
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
    let saved = seed { format = 1, mode = "stub", lifecycle, history = state, references, operations };
    let requested = Request { session_id = seed.session_id, mode = "stub", binding = seed.binding, caps = seed.current_caps };
    // Validation may project stopped/recovery-required; preserve the actual State.
    return match validate(saved, requested) { Ok(_) => Ok(saved), Err(error) => Err(error) };
}

public flow snapshot(state: State, id: string, binding: string, maximum: i32, budget: i32) -> Result<Snapshot, string> {
    let limits = caps(maximum, budget);
    let seed = Snapshot { format = 1, session_id = id, generation = 0, mode = "stub", binding,
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
    return mapped(observed, seed, prior.history.events.len());
}
