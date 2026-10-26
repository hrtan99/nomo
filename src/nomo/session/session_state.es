module nomo.session.session_state;

import std.collections.len as count;
import std.text.len;
import nomo.core.text.printable;
import nomo.core.conversation.{Event, State};

// Draft typed application data, not a codec, storage version or dispatch authority.
public type Caps = { steps: i32, turn_steps: i32, attempts: i32, tokens: i32, scan_bytes: i32 };
public type Ledger = {
    attempts: i32, tokens: i32, scan_bytes: i32,
    step_unit: string, attempt_unit: string, token_unit: string, scan_unit: string
};
public type Operation = { id: string, status: string, attempts: i32, tokens: i32, scan_bytes: i32 };
public type Reference = { operation: string, phase: string };
public type Snapshot = {
    format: i32, session_id: string, generation: i32, mode: string,
    binding: string, lifecycle: string, history: State,
    references: Array<Reference>, operations: Array<Operation>,
    original_caps: Caps, current_caps: Caps, ledger: Ledger
};
public type Request = { session_id: string, mode: string, binding: string, caps: Caps };
public type Projection = {
    session_id: string, generation: i32, mode: string, binding: string,
    disposition: string, history: State, references: Array<Reference>,
    operations: Array<Operation>, original_caps: Caps, caps: Caps, ledger: Ledger
};

flow identifier(value: string) -> bool {
    if len(value) == 0 || len(value) > 128 { return false; }
    return printable(value);
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
    if len(event.role) > 128 || len(event.kind) > 128 || len(event.name) > 128 { return false; }
    if !printable(event.name) { return false; }
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
    if count(saved.history.events) > 32 || count(saved.references) != count(saved.history.events) || count(saved.operations) > 32 {
        return Err("event or operation count invalid");
    }
    if saved.history.characters > 8192 { return Err("history content capacity exceeded"); }
    var characters: usize = 0;
    for event in saved.history.events limit Iterations(32) {
        if !event_valid(event, saved.mode) { return Err("invalid event metadata"); }
        if len(event.text) > 8192 { return Err("history content capacity exceeded"); }
        characters = characters + len(event.name) + len(event.text);
        if characters > 8192 { return Err("history content capacity exceeded"); }
    }
    if characters != saved.history.characters { return Err("cached character count mismatch"); }
    if !saved.history.stopped && (count(saved.history.events) > 31 || characters > 8128) {
        return Err("missing terminal headroom");
    }
    var attempts: i32 = 0;
    var tokens: i32 = 0;
    var scan_bytes: i32 = 0;
    var unresolved = saved.lifecycle == "recovery-required";
    var ids: Array<string> = [];
    for operation in saved.operations limit Iterations(32) {
        if !identifier(operation.id) { return Err("invalid operation identifier"); }
        for id in ids limit Iterations(32) {
            if id == operation.id { return Err("duplicate operation identifier"); }
        }
        ids = ids.push(operation.id);
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
    for reference in saved.references limit Iterations(32) {
        let event = saved.history.events[event_index];
        event_index = event_index + 1;
        if reference.operation == "" {
            if reference.phase != "" || event.role == "model" || event.role == "tool" ||
                (saved.mode == "text-model" && event.role == "assistant") {
                return Err("missing operation reference");
            }
        } else {
            if !identifier(reference.operation) { return Err("invalid operation reference"); }
            var found = false;
            var index: usize = 0;
            for id in ids limit Iterations(32) {
                if reference.operation == id {
                    if index < last_operation { return Err("operation references out of order"); }
                    last_operation = index;
                    found = true;
                }
                index = index + 1;
            }
            if !found { return Err("dangling operation reference"); }
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
    for operation in saved.operations limit Iterations(32) {
        var requests: i32 = 0;
        var outcomes: i32 = 0;
        var tool_outcomes: i32 = 0;
        var request_name = "";
        var index: usize = 0;
        for reference in saved.references limit Iterations(32) {
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
        binding = saved.binding, disposition = disposition,
        history = State { events = saved.history.events, characters = characters, spent = saved.history.spent, stopped = stopped },
        references = saved.references, operations = saved.operations, original_caps = saved.original_caps,
        caps = caps, ledger = ledger });
}
