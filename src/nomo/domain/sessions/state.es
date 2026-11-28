module nomo.domain.sessions.state;

import nomo.domain.conversation.{wire_state};
import nomo.domain.conversation.{TraceKind, TraceRole};
import nomo.domain.wire.{value as json_value, fields as json_fields};
import std.json.JsonValue;
import nomo.domain.conversation.{TraceEvent, TraceState, capacity_error, fresh, stop};
import nomo.domain.limits.{event_bytes, history_bytes};
import nomo.domain.sessions.event_codec.Bundle;
import nomo.domain.text.{input_error, text_printable};
import std.collections.Map;
import std.text.{char_count, from_usize, trim};

public type Admission = {
    prior: Projection,
    reserved: i32
};

public flow plan(saved: SessionSnapshot, requested: Request, generation: i32, input: string) -> Result<
    Admission,
    string
> {
    let prior = match validate(saved, requested) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if generation != 0 || prior.generation != generation || prior.mode != SessionMode.Stub {
        return Err("unsupported or stale checkpoint generation");
    }
    if prior.disposition != ValidationDisposition.Validated || prior.history.stopped {
        return Err("session stopped or recovery required; no continuation");
    }
    let invalid = input_error(input);
    if invalid != "" {
        return Err(invalid);
    }
    let size = char_count(trim(input));
    var characters = 4 * size + 32;
    if characters < size + 1040 {
        characters = size + 1040;
    }
    let full = capacity_error(prior.history, 4, characters);
    if full != "" {
        return Err(full);
    }
    // validate bounded all counters first. These subtractions/additions cannot overflow.
    var bound = prior.caps.steps - prior.history.spent;
    if bound > prior.caps.turn_steps {
        bound = prior.caps.turn_steps;
    }
    if bound > 3 {
        bound = 3;
    }
    if bound <= 0 {
        return Err("session step budget exhausted");
    }
    return Ok(Admission {
        prior,
        reserved = prior.history.spent + bound
    });
}

// Same typed record shape, explicit non-checkpoint phase. The immutable demo claim
// binds the predecessor ID; this row binds generation 0 and the distinct next key.
// Reserved spending is a high-water mark, never measured completed work.
public flow continuing(admitted: Admission, next_save: string) -> StoredSessionMetadata {
    let prior = admitted.prior;
    let reserved = SessionSnapshot {
        format = 1,
        session_id = prior.session_id,
        generation = prior.generation,
        mode = prior.mode,
        binding = prior.binding,
        lifecycle = SessionLifecycle.RecoveryRequired,
        history = prior.history {
            spent = admitted.reserved,
            stopped = true
        },
        references = prior.references,
        operations = prior.operations,
        original_caps = prior.original_caps,
        current_caps = prior.caps,
        ledger = prior.ledger
    };
    let row = pending(reserved, next_save);
    return row {
        phase = MetadataPhase.Continuing
    };
}

public type Request = {
    session_id: string,
    mode: SessionMode,
    binding: string,
    caps: Caps
};

public type Projection = {
    session_id: string,
    generation: i32,
    mode: SessionMode,
    binding: string,
    disposition: ValidationDisposition,
    history: TraceState,
    references: Array<EventReference>,
    operations: Array<SessionOperation>,
    original_caps: Caps,
    caps: Caps,
    ledger: Ledger
};

flow identifier(value: string) -> bool {
    if char_count(value) == 0 || char_count(value) > 128 {
        return false;
    }
    return text_printable(value);
}

flow valid_caps(caps: Caps, mode: SessionMode) -> bool {
    if caps.steps < 1 || caps.steps > 16 || caps.turn_steps < 1 || caps.turn_steps > 16 {
        return false;
    }
    if mode == SessionMode.Stub {
        return caps.attempts == 0 && caps.tokens == 0 && caps.scan_bytes == 0;
    }
    if mode == SessionMode.TextModel {
        return caps.attempts >= 0 && caps.attempts <= 4 && caps.tokens >= 0 && caps.tokens <= 8192
            && caps.scan_bytes == 0;
    }
    return caps.attempts == 0 && caps.tokens == 0 && caps.scan_bytes >= 0 && caps.scan_bytes <= 8192;
}

flow minimum(a: i32, b: i32) -> i32 {
    if a < b {
        return a;
    }
    return b;
}

flow constrain(a: Caps, b: Caps) -> Caps {
    return Caps {
        steps = minimum(a.steps, b.steps),
        turn_steps = minimum(a.turn_steps, b.turn_steps),
        attempts = minimum(a.attempts, b.attempts),
        tokens = minimum(a.tokens, b.tokens),
        scan_bytes = minimum(a.scan_bytes, b.scan_bytes)
    };
}

flow event_valid(event: TraceEvent, mode: SessionMode) -> bool {
    if char_count(event.role.wire()) > 128 || char_count(event.kind.wire()) > 128
        || char_count(event.name) > 128 {
        return false;
    }
    if !text_printable(event.name) {
        return false;
    }
    if event.role == TraceRole.User {
        return event.kind == TraceKind.Input && event.name == "";
    }
    if event.role == TraceRole.Assistant {
        return event.kind == TraceKind.Final && event.name == "";
    }
    if event.role == TraceRole.Error {
        return event.kind == TraceKind.Error && event.name == "";
    }
    if event.role == TraceRole.Model {
        if mode == SessionMode.TextModel {
            return event.kind == TraceKind.Text && event.name == "qwen";
        }
        return event.kind == TraceKind.Request && identifier(event.name);
    }
    return mode != SessionMode.TextModel && event.role == TraceRole.Tool && (
        event.kind == TraceKind.Complete
            || event.kind == TraceKind.Error
    )
        && identifier(event.name);
}

type ReferenceSummary = {
    requests: i32,
    outcomes: i32,
    tool_outcomes: i32,
    request_name: string,
    error: string
};

// All diagnostics are fixed strings; no supplied identifier/content is echoed.
public flow validate(saved: SessionSnapshot, requested: Request) -> Result<Projection, string> {
    if saved.format != 1 {
        return Err("unsupported session format");
    }
    if saved.mode != requested.mode {
        return Err("session mode mismatch");
    }
    if !identifier(saved.session_id) || !identifier(requested.session_id)
        || saved.session_id != requested.session_id {
        return Err("session identifier mismatch or invalid");
    }
    if !identifier(saved.binding) || !identifier(requested.binding) || saved.binding != requested.binding {
        return Err("missing or mismatched binding evidence");
    }
    if saved.generation < 0 {
        return Err("invalid logical generation");
    }
    if (saved.lifecycle == SessionLifecycle.Active && saved.history.stopped)
        || (
        saved.lifecycle == SessionLifecycle.Stopped
            && !saved.history.stopped
    ) {
        return Err("lifecycle and stopped flag disagree");
    }
    if !valid_caps(saved.original_caps, saved.mode) || !valid_caps(saved.current_caps, saved.mode)
        || !valid_caps(requested.caps, saved.mode) {
        return Err("invalid mode-specific caps");
    }
    if saved.current_caps.steps > saved.original_caps.steps
        || saved.current_caps.turn_steps > saved.original_caps.turn_steps
        || saved.current_caps.attempts > saved.original_caps.attempts
        || saved.current_caps.tokens > saved.original_caps.tokens
        || saved.current_caps.scan_bytes > saved.original_caps.scan_bytes {
        return Err("saved caps exceed original caps");
    }
    let ledger = saved.ledger;
    if ledger.step_unit != "steps" || ledger.attempt_unit != "attempts"
        || ledger.token_unit != "total-input-output-tokens" || ledger.scan_unit != "bytes" {
        return Err("invalid budget units");
    }
    // Bound every counter before multiplication/addition; never infer steps from events.
    if saved.history.spent < 0 || saved.history.spent > saved.original_caps.steps || ledger.attempts < 0
        || ledger.attempts > saved.original_caps.attempts || ledger.tokens < 0
        || ledger.tokens > saved.original_caps.tokens || ledger.scan_bytes < 0
        || ledger.scan_bytes > saved.original_caps.scan_bytes {
        return Err("invalid saved counters");
    }
    if saved.mode == SessionMode.TextModel && (
        saved.history.spent != ledger.attempts
            || ledger.tokens != ledger.attempts * 2048
    ) {
        return Err("model reservation mismatch");
    }
    if saved.history.events.len() > 32 || saved.references.len() != saved.history.events.len()
        || saved.operations.len() > 32 {
        return Err("event or operation count invalid");
    }
    if saved.history.characters > history_bytes() {
        return Err("history content capacity exceeded");
    }
    var characters: usize = 0;
    @limits([Iterations(32)]) for event in saved.history.events {
        if !event_valid(event, saved.mode) {
            return Err("invalid event metadata");
        }
        if char_count(event.text) > event_bytes() {
            return Err("history content capacity exceeded");
        }
        characters = characters + char_count(event.name) + char_count(event.text);
        if characters > history_bytes() {
            return Err("history content capacity exceeded");
        }
    }
    if characters != saved.history.characters {
        return Err("cached character count mismatch");
    }
    if !saved.history.stopped && (saved.history.events.len() > 31 || characters > history_bytes() - 64) {
        return Err("missing terminal headroom");
    }
    var attempts: i32 = 0;
    var tokens: i32 = 0;
    var scan_bytes: i32 = 0;
    var unresolved = saved.lifecycle == SessionLifecycle.RecoveryRequired;
    var ids: Map<string, usize> = Map.new();
    var summaries: Map<string, ReferenceSummary> = Map.new();
    for (index, operation) in saved.operations.iter().enumerate() {
        if !identifier(operation.id) {
            return Err("invalid operation identifier");
        }
        if ids.contains_key(operation.id) {
            return Err("duplicate operation identifier");
        }
        ids = ids.insert(operation.id, index);
        if operation.status != OperationStatus.Completed {
            unresolved = true;
        }
        if saved.mode == SessionMode.TextModel {
            if operation.attempts != 1 || operation.tokens != 2048 || operation.scan_bytes != 0 {
                return Err("invalid model operation reservation");
            }
        } else {
            if operation.attempts != 0 || operation.tokens != 0 {
                return Err("cross-mode operation reservation");
            }
            if saved.mode == SessionMode.Stub && operation.scan_bytes != 0 {
                return Err("cross-mode operation reservation");
            }
            if saved.mode == SessionMode.ScriptedRead && operation.scan_bytes != 4096 {
                return Err("invalid scan reservation");
            }
        }
        attempts = attempts + operation.attempts;
        tokens = tokens + operation.tokens;
        scan_bytes = scan_bytes + operation.scan_bytes;
        summaries = summaries.insert(
            operation.id,
            ReferenceSummary {
                requests = 0,
                outcomes = 0,
                tool_outcomes = 0,
                request_name = "",
                error = ""
            }
        );
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
        match reference {
            EventReference.Unbound => {
                if event.role == TraceRole.Model || event.role == TraceRole.Tool
                    || (saved.mode == SessionMode.TextModel && event.role == TraceRole.Assistant) {
                    return Err("missing operation reference");
                }
            },
            EventReference.Bound(operation, phase) => {
                if !identifier(operation) {
                    return Err("invalid operation reference");
                }
                let index = match ids.get(operation) {
                    Some(value) => value,
                    None() => {
                        return Err("dangling operation reference");
                    }
                };
                if index < last_operation {
                    return Err("operation references out of order");
                }
                last_operation = index;
                if phase == ReferencePhase.Request {
                    if event.role != TraceRole.Model {
                        return Err("contradictory request reference");
                    }
                } else {
                    if phase != ReferencePhase.Outcome || (
                        event.role != TraceRole.Tool && event.role != TraceRole.Error
                            && !(
                            saved.mode == SessionMode.TextModel
                                && event.role == TraceRole.Assistant
                        )
                    ) {
                        return Err("contradictory outcome reference");
                    }
                }
                var summary = summaries.get(operation).unwrap();
                if phase == ReferencePhase.Request {
                    if summary.outcomes != 0 && summary.error == "" {
                        summary = summary {
                            error = "request follows outcome"
                        };
                    }
                    summary = summary {
                        requests = summary.requests + 1,
                        request_name = event.name
                    };
                } else {
                    if event.role == TraceRole.Tool && (
                        summary.requests != 1
                            || event.name != summary.request_name
                    )
                        && summary.error == "" {
                        summary = summary {
                            error = "tool outcome does not match request"
                        };
                    }
                    summary = summary {
                        outcomes = summary.outcomes + 1,
                        tool_outcomes = summary.tool_outcomes + if event.role == TraceRole.Tool {
                            1
                        } else {
                            0
                        }
                    };
                }
                summaries = summaries.insert(operation, summary);
            }
        }
    }
    var required_steps: i32 = 0;
    @limits([Iterations(32)]) for operation in saved.operations {
        let summary = summaries.get(operation.id).unwrap();
        if summary.error != "" {
            return Err(summary.error);
        }
        let requests = summary.requests;
        let outcomes = summary.outcomes;
        if requests > 1 || outcomes > 1 || (operation.status == OperationStatus.Completed && outcomes != 1)
            || (operation.status != OperationStatus.Completed && outcomes != 0) {
            return Err("operation status and events disagree");
        }
        if saved.mode != SessionMode.ScriptedRead && operation.status == OperationStatus.Completed
            && requests != 1 {
            return Err("completed operation missing request");
        }
        // Scripted reads reserve before input validation; a completed preflight error
        // can have no request/charged step. No outcome means uncertainty, not refund.
        required_steps = required_steps + requests;
        required_steps = required_steps + summary.tool_outcomes;
    }
    if required_steps > saved.history.spent {
        return Err("operation step counter mismatch");
    }
    let caps = constrain(saved.current_caps, requested.caps);
    var stopped = saved.history.stopped || unresolved || saved.history.spent >= caps.steps;
    if saved.mode == SessionMode.TextModel && (
        ledger.attempts >= caps.attempts || ledger.tokens
            + 2048 > caps.tokens
    ) {
        stopped = true;
    }
    if saved.mode == SessionMode.ScriptedRead && ledger.scan_bytes + 4096 > caps.scan_bytes {
        stopped = true;
    }
    var disposition = ValidationDisposition.Validated;
    if unresolved {
        disposition = ValidationDisposition.RecoveryRequired;
    }
    return Ok(
        Projection {
            session_id = saved.session_id,
            generation = saved.generation,
            mode = saved.mode,
            binding = saved.binding,
            disposition,
            history = saved.history {
                characters,
                stopped
            },
            references = saved.references,
            operations = saved.operations,
            original_caps = saved.original_caps,
            caps,
            ledger
        }
    );
}

public flow valid_id(value: string) -> bool {
    if char_count(value) == 0 || char_count(value) > 128 {
        return false;
    }
    return text_printable(value);
}

public flow session_key(id: string, save_id: string) -> string {
    // Length prefixes make pairs unambiguous even when IDs contain delimiters.
    return "nomo-store-v1:" + std.text.from_usize(char_count(id)) + ":" + id + save_id;
}

public flow with_events(saved: SessionSnapshot, events: Array<TraceEvent>) -> SessionSnapshot {
    return saved {
        history = saved.history {
            events
        }
    };
}

public flow pending(saved: SessionSnapshot, save_id: string) -> StoredSessionMetadata {
    let descriptors = saved.history.events.iter().map(event => event {
        text = ""
    }).collect();
    return StoredSessionMetadata {
        format = 1,
        phase = MetadataPhase.Pending,
        save_id,
        session_key = session_key(saved.session_id, save_id),
        snapshot = with_events(saved, descriptors)
    };
}

public flow published(row: StoredSessionMetadata) -> StoredSessionMetadata {
    return row {
        phase = MetadataPhase.Published
    };
}

public flow bundle(saved: SessionSnapshot, save_id: string) -> Bundle {
    let bodies = saved.history.events.iter().map(event => event.text).collect();
    return Bundle {
        format = 1,
        session_id = saved.session_id,
        save_id,
        bodies
    };
}

public flow restore(row: StoredSessionMetadata, body: Bundle) -> Result<SessionSnapshot, string> {
    if row.format != 1 || (row.phase != MetadataPhase.Pending && row.phase != MetadataPhase.Published) {
        return Err("invalid metadata format or phase");
    }
    if !valid_id(row.save_id) || !valid_id(row.snapshot.session_id) {
        return Err("invalid metadata identity");
    }
    if row.session_key != session_key(row.snapshot.session_id, row.save_id) || body.format != 1
        || body.session_id != row.snapshot.session_id || body.save_id != row.save_id {
        return Err("bundle identity mismatch");
    }
    let saved = row.snapshot;
    if body.bodies.len() > 32 || saved.history.events.len() != body.bodies.len()
        || saved.references.len() != body.bodies.len() || saved.operations.len() > 32 {
        return Err("bundle descriptor count mismatch");
    }
    var events: Array<TraceEvent> = [];
    var index: usize = 0;
    @limits([Iterations(32)]) for descriptor in saved.history.events {
        if descriptor.text != "" {
            return Err("metadata contains duplicate event body");
        }
        events = events.push(descriptor {
            text = body.bodies[index]
        });
        index = index + 1;
    }
    return Ok(with_events(saved, events));
}

public flow caps(maximum: i32, budget: i32) -> Caps {
    return Caps {
        steps = budget,
        turn_steps = maximum,
        attempts = 0,
        tokens = 0,
        scan_bytes = 0
    };
}

// Map observed application data only. An error after a request is not evidence
// that the requested tool ran, and never becomes a fabricated completed outcome.
flow mapped(state: TraceState, seed: SessionSnapshot, prefix: usize) -> Result<SessionSnapshot, string> {
    if state.events.len() > 32 {
        return Err("stub event count exceeds limit");
    }
    if state.events.len() < prefix {
        return Err("stub predecessor prefix missing");
    }
    var operations = seed.operations;
    var references = seed.references;
    var unresolved = false;
    var index: usize = 0;
    @limits([Iterations(32)]) for event in state.events {
        if index < prefix {
            if event != seed.history.events[index] {
                return Err("stub predecessor prefix changed");
            }
        } else if event.role == TraceRole.Model && event.kind == TraceKind.Request {
            let operation = if seed.generation == 0 {
                "stub-request-" + from_usize(index)
            }
            else {
                "stub-successor-request-" + from_usize(index)
            };
            var status = OperationStatus.Pending;
            if index + 1 < state.events.len() {
                let next = state.events[index + 1];
                if next.role == TraceRole.Tool && next.name == event.name && (
                    next.kind == TraceKind.Complete
                        || next.kind == TraceKind.Error
                ) {
                    status = OperationStatus.Completed;
                }
            }
            if status == OperationStatus.Pending {
                unresolved = true;
            }
            operations = operations.push(
                SessionOperation {
                    id = operation,
                    status,
                    attempts = 0,
                    tokens = 0,
                    scan_bytes = 0
                }
            );
            references = references.push(EventReference.Bound(operation, ReferencePhase.Request));
        } else if event.role == TraceRole.Tool {
            if index == 0 {
                return Err("stub tool outcome has no request");
            }
            let prior = state.events[index - 1];
            if prior.role != TraceRole.Model || prior.kind != TraceKind.Request || prior.name != event.name {
                return Err("stub tool outcome has no matching request");
            }
            references = references.push(
                match references[index - 1] {
                    EventReference.Bound(operation, ReferencePhase.Request) => EventReference.Bound(
                        operation,
                        ReferencePhase.Outcome
                    ),
                    _ => {
                        return Err("stub tool outcome has no matching request reference");
                    }
                }
            );
        } else {
            references = references.push(EventReference.Unbound);
        }
        index = index + 1;
    }
    var lifecycle = SessionLifecycle.Active;
    if unresolved {
        lifecycle = SessionLifecycle.RecoveryRequired;
    }
    else if state.stopped {
        lifecycle = SessionLifecycle.Stopped;
    }
    let saved = seed {
        format = 1,
        mode = SessionMode.Stub,
        lifecycle,
        history = state,
        references,
        operations
    };
    let requested = Request {
        session_id = seed.session_id,
        mode = SessionMode.Stub,
        binding = seed.binding,
        caps = seed.current_caps
    };
    // Validation may project stopped/recovery-required; preserve the actual State.
    return match validate(saved, requested) {
        Ok(_) => Ok(saved),
        Err(error) => Err(error)
    };
}

public flow snapshot(state: TraceState, id: string, binding: string, maximum: i32, budget: i32) -> Result<
    SessionSnapshot,
    string
> {
    let limits = caps(maximum, budget);
    let seed = SessionSnapshot {
        format = 1,
        session_id = id,
        generation = 0,
        mode = SessionMode.Stub,
        binding,
        lifecycle = SessionLifecycle.Active,
        history = fresh(),
        references = [],
        operations = [],
        original_caps = limits,
        current_caps = limits,
        ledger = Ledger {
            attempts = 0,
            tokens = 0,
            scan_bytes = 0,
            step_unit = "steps",
            attempt_unit = "attempts",
            token_unit = "total-input-output-tokens",
            scan_unit = "bytes"
        }
    };
    return mapped(state, seed, 0);
}

// Only an observed source-returned turn can settle the absolute admission bound.
public flow successor(state: TraceState, prior: Projection, reserved: i32, status: i32) -> Result<
    SessionSnapshot,
    string
> {
    if prior.mode != SessionMode.Stub || prior.generation != 0
        || prior.disposition != ValidationDisposition.Validated
        || prior.history.stopped || state.spent < prior.history.spent || state.spent > reserved
        || reserved > prior.caps.steps {
        return Err("invalid stub settlement");
    }
    let observed = if status == 4 || state.spent >= prior.caps.steps {
        stop(state)
    } else {
        state
    };
    let seed = SessionSnapshot {
        format = 1,
        session_id = prior.session_id,
        generation = 1,
        mode = prior.mode,
        binding = prior.binding,
        lifecycle = SessionLifecycle.Active,
        history = prior.history,
        references = prior.references,
        operations = prior.operations,
        original_caps = prior.original_caps,
        current_caps = prior.caps,
        ledger = prior.ledger
    };
    return mapped(observed, seed, prior.history.events.len());
}

public type DemoSessionClaim = {
    format: i32,
    phase: DemoClaimPhase,
    session_id: string,
    save_id: string,
    binding: string,
    maximum: i32,
    budget: i32
};

// Draft typed application data, not a codec, storage version or dispatch authority.
public type Caps = {
    steps: i32,
    turn_steps: i32,
    attempts: i32,
    tokens: i32,
    scan_bytes: i32
};

public type Ledger = {
    attempts: i32,
    tokens: i32,
    scan_bytes: i32,
    step_unit: string,
    attempt_unit: string,
    token_unit: string,
    scan_unit: string
};

public type SessionOperation = {
    id: string,
    status: OperationStatus,
    attempts: i32,
    tokens: i32,
    scan_bytes: i32
};

public enum EventReference {
    Unbound,
    Bound(string, ReferencePhase)
}

public type SessionSnapshot = {
    format: i32,
    session_id: string,
    generation: i32,
    mode: SessionMode,
    binding: string,
    lifecycle: SessionLifecycle,
    history: TraceState,
    references: Array<EventReference>,
    operations: Array<SessionOperation>,
    original_caps: Caps,
    current_caps: Caps,
    ledger: Ledger
};

// Application metadata only: event bodies belong to the single Session bundle.
public type StoredSessionMetadata = {
    format: i32,
    phase: MetadataPhase,
    save_id: string,
    session_key: string,
    snapshot: SessionSnapshot
};

public enum SessionMode {
    Stub,
    TextModel,
    ScriptedRead
}

impl SessionMode {
    public flow wire(self) -> string ![] {
        return match self {
            SessionMode.Stub => "stub",
            SessionMode.TextModel => "text-model",
            SessionMode.ScriptedRead => "scripted-read"
        };
    }

    public flow parse(raw: string) -> SessionMode ![] {
        return match raw {
            "stub" => SessionMode.Stub,
            "text-model" => SessionMode.TextModel,
            "scripted-read" => SessionMode.ScriptedRead,
            _ => abort("invalid SessionMode spelling: " + raw)
        };
    }
}

public enum ValidationDisposition {
    Validated,
    RecoveryRequired
}

impl ValidationDisposition {
    public flow wire(self) -> string ![] {
        return match self {
            ValidationDisposition.Validated => "validated",
            ValidationDisposition.RecoveryRequired => "recovery-required"
        };
    }

    public flow parse(raw: string) -> ValidationDisposition ![] {
        return match raw {
            "validated" => ValidationDisposition.Validated,
            "recovery-required" => ValidationDisposition.RecoveryRequired,
            _ => abort("invalid ValidationDisposition spelling: " + raw)
        };
    }
}

public enum SessionLifecycle {
    Active,
    Stopped,
    RecoveryRequired
}

impl SessionLifecycle {
    public flow wire(self) -> string ![] {
        return match self {
            SessionLifecycle.Active => "active",
            SessionLifecycle.Stopped => "stopped",
            SessionLifecycle.RecoveryRequired => "recovery-required"
        };
    }

    public flow parse(raw: string) -> SessionLifecycle ![] {
        return match raw {
            "active" => SessionLifecycle.Active,
            "stopped" => SessionLifecycle.Stopped,
            "recovery-required" => SessionLifecycle.RecoveryRequired,
            _ => abort("invalid SessionLifecycle spelling: " + raw)
        };
    }
}

public enum OperationStatus {
    Completed,
    Pending,
    Unknown
}

impl OperationStatus {
    public flow wire(self) -> string ![] {
        return match self {
            OperationStatus.Completed => "completed",
            OperationStatus.Pending => "pending",
            OperationStatus.Unknown => "unknown"
        };
    }

    public flow parse(raw: string) -> OperationStatus ![] {
        return match raw {
            "completed" => OperationStatus.Completed,
            "pending" => OperationStatus.Pending,
            "unknown" => OperationStatus.Unknown,
            _ => abort("invalid OperationStatus spelling: " + raw)
        };
    }
}

public enum ReferencePhase {
    Request,
    Outcome
}

impl ReferencePhase {
    public flow wire(self) -> string ![] {
        return match self {
            ReferencePhase.Request => "request",
            ReferencePhase.Outcome => "outcome"
        };
    }

    public flow parse(raw: string) -> ReferencePhase ![] {
        return match raw {
            "request" => ReferencePhase.Request,
            "outcome" => ReferencePhase.Outcome,
            _ => abort("invalid ReferencePhase spelling: " + raw)
        };
    }
}

public enum MetadataPhase {
    Pending,
    Published,
    Continuing
}

impl MetadataPhase {
    public flow wire(self) -> string ![] {
        return match self {
            MetadataPhase.Pending => "pending",
            MetadataPhase.Published => "published",
            MetadataPhase.Continuing => "continuing"
        };
    }

    public flow parse(raw: string) -> MetadataPhase ![] {
        return match raw {
            "pending" => MetadataPhase.Pending,
            "published" => MetadataPhase.Published,
            "continuing" => MetadataPhase.Continuing,
            _ => abort("invalid MetadataPhase spelling: " + raw)
        };
    }
}

public enum DemoClaimPhase {
    Claimed,
    Ready,
    ContinueClaimed
}

impl DemoClaimPhase {
    public flow wire(self) -> string ![] {
        return match self {
            DemoClaimPhase.Claimed => "claimed",
            DemoClaimPhase.Ready => "ready",
            DemoClaimPhase.ContinueClaimed => "continue-claimed"
        };
    }

    public flow parse(raw: string) -> DemoClaimPhase ![] {
        return match raw {
            "claimed" => DemoClaimPhase.Claimed,
            "ready" => DemoClaimPhase.Ready,
            "continue-claimed" => DemoClaimPhase.ContinueClaimed,
            _ => abort("invalid DemoClaimPhase spelling: " + raw)
        };
    }
}

public flow wire_reference(input: EventReference) -> JsonValue ![] {
    let updates: Array<(string, JsonValue)> = match input {
        EventReference.Unbound => [("operation", JsonValue.String("")), ("phase", JsonValue.String(""))],
        EventReference.Bound(operation, phase) => [
            ("operation", JsonValue.String(operation)),
            ("phase", JsonValue.String(phase.wire()))
        ]
    };
    return json_fields(JsonValue.Object(Map.new()), updates);
}

public flow wire_operation(input: SessionOperation) -> JsonValue ![] {
    return json_fields(json_value(input), [("status", JsonValue.String(input.status.wire()))]);
}

public flow wire_snapshot(input: SessionSnapshot) -> JsonValue ![] {
    return json_fields(
        json_value(input),
        [
            ("history", wire_state(input.history)),
            ("mode", JsonValue.String(input.mode.wire())),
            ("lifecycle", JsonValue.String(input.lifecycle.wire())),
            ("references", JsonValue.Array(input.references.iter().map(reference => wire_reference(reference)).collect())),
            ("operations", JsonValue.Array(input.operations.iter().map(operation => wire_operation(operation)).collect()))
        ]
    );
}

public flow wire_projection(input: Projection) -> JsonValue ![] {
    return json_fields(
        json_value(input),
        [
            ("history", wire_state(input.history)),
            ("mode", JsonValue.String(input.mode.wire())),
            ("disposition", JsonValue.String(input.disposition.wire())),
            ("references", JsonValue.Array(input.references.iter().map(reference => wire_reference(reference)).collect())),
            ("operations", JsonValue.Array(input.operations.iter().map(operation => wire_operation(operation)).collect()))
        ]
    );
}

public flow wire_session_metadata(input: StoredSessionMetadata) -> JsonValue ![] {
    return json_fields(
        json_value(input),
        [("phase", JsonValue.String(input.phase.wire())), ("snapshot", wire_snapshot(input.snapshot))]
    );
}

public flow wire_demo_claim(input: DemoSessionClaim) -> JsonValue ![] {
    return json_fields(json_value(input), [("phase", JsonValue.String(input.phase.wire()))]);
}
