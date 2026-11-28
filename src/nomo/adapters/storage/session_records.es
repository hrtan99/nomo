module nomo.adapters.storage.session_records;

import nomo.domain.conversation.{TraceKind, TraceRole};
import nomo.domain.sessions.state.MetadataPhase;
import nomo.application.resources.PolicyRoot;
import nomo.application.sessions.persistence.committed_version;
import nomo.application.sessions.ports.{Submission, Target};
import nomo.domain.conversation.TraceEvent;
import nomo.domain.limits.event_bytes;
import nomo.domain.sessions.event_codec.{Bundle, RecordedTraceHistory, Policy, bundle_codec_decode, bundle_codec_encode, events, policy_error};
import nomo.domain.sessions.state.{
    DemoSessionClaim,
    StoredSessionMetadata,
    Projection,
    Request,
    SessionSnapshot,
    bundle,
    pending,
    published,
    restore,
    session_key,
    valid_id,
    validate
};
import nomo.domain.text.{data_safe, safe};
import std.agent.message.Message;
import std.agent.session.{SessionHistoryPage, history_page};
import std.codec.text.{Strict, utf8_decode};
import std.fs.{IOError, ReadLimitError, WorkspacePath, path, read_bytes_limited};
import std.json.{parse, stringify};
import std.memory.{MemoryEntry, MemoryVersion, Missing, StorageData, WriteCondition};

// A typed Store is forwarded intact. Prepare and commit stay in this flow so
// the native intent never crosses a generic return boundary.
public flow commit_native<Row ~ StorageData>(
    store: Store<string, Row>,
    target: Target,
    value: Row,
    condition: WriteCondition
) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let version = match commit_receipt(store, target, value, condition) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let after = match store.get_entry(target.key) {
        Some(item) => item,
        None() => {
            return Err(target.label + " readback missing");
        }
    };
    if after.key != target.key || after.value != value || after.version.opaque != version.opaque {
        return Err(target.label + " readback mismatch; no retry");
    }
    return Ok(version);
}

public flow submit_native<Row ~ StorageData>(
    store: Store<string, Row>,
    key: string,
    value: Row,
    condition: WriteCondition
) -> Submission ![Memory, Error<StorageError>] {
    let intent = store.prepare_put(key, value, condition);
    return Submission {
        operation = intent.operation_ref(),
        outcome = intent.commit()
    };
}

// Namespace-specific consumers retain their own readback and transition checks.
public flow commit_receipt<Row ~ StorageData>(
    store: Store<string, Row>,
    target: Target,
    value: Row,
    condition: WriteCondition
) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    return committed_version(target, submit_native(store, target.key, value, condition));
}

public flow read_claim() -> Option<MemoryEntry<string, DemoSessionClaim>> {
    return DemoClaims.Claims.get_entry("single-demo");
}

// Exact durable receipt and committed-version readback; no retry or reconciliation.
public flow write_claim(value: DemoSessionClaim, condition: WriteCondition) -> Result<MemoryVersion, string> ![
    Memory,
    Error<StorageError>
] {
    return commit_native<DemoSessionClaim>(
        DemoClaims.Claims,
        Target {
            store = ["Claims"],
            region = "nomo-session-demo-v1",
            key = "single-demo",
            label = "demo"
        },
        value,
        condition
    );
}

flow read_raw() -> Option<MemoryEntry<string, RecordedTraceHistory>> {
    return EventHistory.Rows.get_entry("events");
}

flow invalid(value: RecordedTraceHistory) -> string {
    if value.format != 1 || value.turns < 1 || value.turns > 2 || value.events.len() < 1
        || value.events.len() > 48 {
        return "invalid event history bounds";
    }
    if value.first_count < 1 || value.first_count > value.events.len() || (
        value.turns == 1
            && value.first_count != value.events.len()
    ) || (
        value.turns == 2
            && value.first_count == value.events.len()
    ) {
        return "invalid event turn boundary";
    }
    @limits([Iterations(48)]) for event in value.events {
        if !safe(event.role.wire(), 128) || !safe(event.kind.wire(), 128) || !safe(event.name, 128)
            || !data_safe(event.text, event_bytes()) {
            return "invalid event history content";
        }
    }
    return "";
}

public flow event_history_load() -> Result<Option<MemoryEntry<string, RecordedTraceHistory>>, string> {
    let entry = read_raw();
    match entry {
        Some(value) => {
            if value.key != "events" {
                return Err("event history key mismatch");
            }
            let error = invalid(value.value);
            if error != "" {
                return Err(error);
            }
        }
        None() => (),
    }
    return Ok(entry);
}

public flow event_history_append(turn: i32, input: Array<TraceEvent>, policy: Policy) -> Result<
    MemoryVersion,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let clean = match events(input, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if clean.events.len() == 0 {
        return Err("empty event batch");
    }
    let before = match event_history_load() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    var prior: Array<TraceEvent> = [];
    let previous_turn = match before {
        Some(entry) => {
            prior = entry.value.events;
            entry.value.turns
        }
        None() => 0
    };
    let first_count = match before {
        Some(entry) => entry.value.first_count,
        None() => clean.events.len()
    };
    if turn != previous_turn + 1 || turn > 2 {
        return Err("event batch order differs; no retry");
    }
    prior = prior.extend(clean.events);
    let next = RecordedTraceHistory {
        format = 1,
        turns = turn,
        first_count,
        events = prior
    };
    let error = invalid(next);
    if error != "" {
        return Err(error);
    }
    let condition: WriteCondition = match before {
        Some(entry) => WriteCondition.Match(entry.version),
        None() => Missing
    };
    let version = match commit_receipt(
        EventHistory.Rows,
        Target {
            store = ["Rows"],
            region = "nomo-event-history-v1",
            key = "events",
            label = "event history"
        },
        next,
        condition
    ) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let after = match event_history_load() {
        Ok(Some(value)) => value,
        _ => {
            return Err("event history readback missing or invalid");
        }
    };
    if after.value != next || after.version.opaque != version.opaque {
        return Err("event history readback mismatch; no retry");
    }
    match before {
        Some(value) => {
            if value.version.opaque == version.opaque {
                return Err("event history version did not change");
            }
        },
        None() => (),
    }
    return Ok(version);
}

// A conservative product projection: all free text and unrecognized metadata
// are removed. This preserves event ordering, not full tool-result content.
public flow append_metadata(turn: i32, input: Array<TraceEvent>) -> Result<MemoryVersion, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if input.len() < 1 || input.len() > 24 {
        return Err("event batch exceeds bounds");
    }
    var clean: Array<TraceEvent> = [];
    @limits([Iterations(24)]) for item in input {
        let role = if item.role == TraceRole.User || item.role == TraceRole.Main
            || item.role == TraceRole.Tool
            || item.role == TraceRole.Model || item.role == TraceRole.Assistant
            || item.role == TraceRole.Error {
            item.role
        } else {
            TraceRole.Other
        };
        let kind = if item.kind == TraceKind.Request || item.kind == TraceKind.Plan
            || item.kind == TraceKind.Delegate
            || item.kind == TraceKind.Context || item.kind == TraceKind.Input || item.kind == TraceKind.Tool
            || item.kind == TraceKind.Result
            || item.kind == TraceKind.Consume || item.kind == TraceKind.Answer || item.kind == TraceKind.Final
            || item.kind == TraceKind.Error {
            item.kind
        } else {
            TraceKind.TraceEvent
        };
        let name = if item.name == "child-1" || item.name == "read" || item.name == "search" {
            item.name
        } else {
            ""
        };
        clean = clean.push(TraceEvent {
            role,
            kind,
            name,
            text = "[REDACTED]"
        });
    }
    return event_history_append(turn, clean, Policy {
        format = 1,
        literals = ["NOMO_REDACTION_SENTINEL"]
    });
}

// The caller supplies a private read-only policy directory for every process.
// This exact-literal list is not comprehensive secret detection or authority.
public flow event_policy_load() -> Result<Policy, string> {
    let selected: Result<WorkspacePath<PolicyRoot>, IOError> = path<PolicyRoot>("policy.json");
    let location = match selected {
        Ok(item) => item,
        Err(_) => {
            return Err("event policy path refused");
        }
    };
    return handle {
        let bytes = read_bytes_limited(location, 4096);
        let raw = match utf8_decode(bytes, Strict) {
            Ok(item) => item,
            Err(_) => {
                return Err("event policy must be UTF-8");
            }
        };
        let value = match parse(raw) {
            Ok(item) => item,
            Err(_) => {
                return Err("event policy JSON invalid");
            }
        };
        let converted: Option<Message<Policy>> = Message.new(value).cast<Policy>();
        let policy = match converted {
            Some(item) => item.body,
            None() => {
                return Err("event policy shape invalid");
            }
        };
        let error = policy_error(policy);
        if error != "" {
            return Err(error);
        }
        Ok(policy)
    } with {
        Error<ReadLimitError>.raise(ReadLimitError.LimitExceeded(maximum)) => {
            if maximum != 4096 {
                abort("unexpected event policy read bound");
            }
            finish Err("event policy exceeds bound");
        }
    };
}

flow unselected(page: SessionHistoryPage) -> bool {
    let terminal = match page.cursor {
        None() => true,
        _ => false
    };
    let no_context = match page.published_context {
        None() => true,
        _ => false
    };
    let no_summary = match page.summary {
        None() => true,
        _ => false
    };
    return terminal && no_context && no_summary;
}

// Provisioning is a fixture precondition. Missing/corrupt Session is never "empty".
public flow empty(key: string) -> bool {
    let page = history_page(SessionConfig.continue_or_new(key), None(), 2);
    return unselected(page) && page.messages.len() == 0;
}

public flow history_store_append(key: string, body: Bundle) -> Result<bool, string> ![
    Memory,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let encoded = match bundle_codec_encode(body) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let payload = match parse(encoded) {
        Ok(value) => value,
        Err(_) => {
            return Err("invalid encoded bundle");
        }
    };
    let message = Message.with_session(Message.new(payload), SessionConfig.continue_or_new(key));
    return Ok(true);
}

public flow history_store_load(key: string) -> Result<Bundle, string> {
    let page = history_page(SessionConfig.continue_or_new(key), None(), 2);
    if !unselected(page) || page.messages.len() != 1 {
        return Err("expected exactly one complete bundle");
    }
    let encoded = match stringify(page.messages[0].body) {
        Ok(value) => value,
        Err(_) => {
            return Err("unreadable bundle JSON");
        }
    };
    return bundle_codec_decode(encoded);
}

public flow read(id: string) -> Option<MemoryEntry<string, StoredSessionMetadata>> {
    return SessionMetadata.Rows.get_entry(id);
}

// Transition only against the observed/confirmed version, then verify the receipt's
// committed version and exact row. Unknown/refused writes return without retry.
public flow publish(row: StoredSessionMetadata, expected: MemoryVersion) -> Result<MemoryVersion, string> ![
    Memory,
    Error<StorageError>
] {
    let committed = match write(row, std.memory.WriteCondition.Match(expected)) {
        Ok(version) => version,
        Err(error) => {
            return Err(error);
        }
    };
    let observed = match read(row.snapshot.session_id) {
        Some(value) => value,
        None() => {
            return Err("published metadata missing");
        }
    };
    if observed.key != row.snapshot.session_id || observed.value != row
        || observed.version.opaque == expected.opaque || observed.version.opaque != committed.opaque {
        return Err("published metadata readback mismatch");
    }
    return Ok(observed.version);
}

// A confirmed Memory mutation is not proof of Session content or effect completion.
public flow write(row: StoredSessionMetadata, condition: WriteCondition) -> Result<MemoryVersion, string> ![
    Memory,
    Error<StorageError>
] {
    return commit_receipt<StoredSessionMetadata>(
        SessionMetadata.Rows,
        Target {
            store = ["Rows"],
            region = "nomo-session-store-v1",
            key = row.snapshot.session_id,
            label = "metadata"
        },
        row,
        condition
    );
}

// Shared metadata/history publication tail. The caller must already own the
// exact current metadata version; unknown writes are never retried.
public flow publish_snapshot(
    saved: SessionSnapshot,
    save_id: string,
    expected: StoredSessionMetadata,
    version: MemoryVersion,
    continuation: bool
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let next = published(pending(saved, save_id));
    let body = bundle(saved, save_id);
    match bundle_codec_encode(body) {
        Err(error) => {
            return Err(error);
        }
        Ok(_) => (),
    }
    match history_store_append(next.session_key, body) {
        Err(error) => {
            return Err(error);
        }
        Ok(_) => (),
    }
    let observed = match history_store_load(next.session_key) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let restored = match restore(next, observed) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if observed != body {
        return Err(if continuation {
            "successor bundle differs from intent"
        } else {
            "appended bundle differs from intent"
        });
    }
    if restored != saved {
        return Err(if continuation {
            "successor bundle differs from intent"
        } else {
            "history and metadata disagree"
        });
    }
    let current = match read(saved.session_id) {
        Some(value) => value,
        None() => {
            return Err(if continuation {
                "admission missing"
            } else {
                "pending metadata missing"
            });
        }
    };
    if current.value != expected || current.version.opaque != version.opaque {
        return Err(if continuation {
            "admission changed"
        } else {
            "pending metadata changed"
        });
    }
    return match publish(next, version) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

// Only a new ID in a fixture-provisioned empty namespace; no update, retry or repair.
public flow save(saved: SessionSnapshot, requested: Request, save_id: string) -> Result<Projection, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if !valid_id(save_id) {
        return Err("invalid save identity");
    }
    let projection = match validate(saved, requested) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let body = bundle(saved, save_id);
    match bundle_codec_encode(body) {
        Err(error) => {
            return Err(error);
        }
        Ok(_) => (),
    }
    match read(saved.session_id) {
        Some(_) => {
            return Err("session metadata already exists");
        }
        None() => (),
    }
    let row = pending(saved, save_id);
    if !empty(row.session_key) {
        return Err("session history is not empty");
    }
    let version = match write(row, Missing) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    // Only this confirmed intent permits the sole append. Unknown stops above.
    match publish_snapshot(saved, save_id, row, version, false) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    return Ok(projection);
}

// Fresh readback resolves only current published data, never an automatic repair.
public flow reload(requested: Request, save_id: string) -> Result<Projection, string> {
    if !valid_id(requested.session_id) || !valid_id(save_id) {
        return Err("invalid requested identity");
    }
    let before = match read(requested.session_id) {
        Some(value) => value,
        None() => {
            return Err("session metadata missing");
        }
    };
    let row = before.value;
    if row.format != 1 || row.snapshot.session_id != requested.session_id || row.save_id != save_id
        || row.session_key != session_key(requested.session_id, save_id) {
        return Err("metadata identity mismatch");
    }
    if row.phase == MetadataPhase.Pending {
        return Err("pending save; recovery required; no retry");
    }
    if row.phase != MetadataPhase.Published {
        return Err("invalid metadata phase");
    }
    let body = match history_store_load(row.session_key) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let saved = match restore(row, body) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let after = match read(requested.session_id) {
        Some(value) => value,
        None() => {
            return Err("metadata disappeared");
        }
    };
    if after.version.opaque != before.version.opaque || after.value != row {
        return Err("metadata changed during reload");
    }
    return validate(saved, requested);
}

alias DemoClaimsSchema = MemoryRegion<{
    Claims: Store<string, DemoSessionClaim>
}>;

public let DemoClaims = std.memory.region<DemoClaimsSchema>(
    stable_id = "nomo-session-demo-v1",
    store = "session-demo"
);

alias EventHistorySchema = MemoryRegion<{
    Rows: Store<string, RecordedTraceHistory>
}>;

public let EventHistory = std.memory.region<EventHistorySchema>(
    stable_id = "nomo-event-history-v1",
    store = "event-history"
);

alias SessionMetadataSchema = MemoryRegion<{
    Rows: Store<string, StoredSessionMetadata>
}>;

public let SessionMetadata = std.memory.region<SessionMetadataSchema>(
    stable_id = "nomo-session-store-v1",
    store = "session"
);
