module nomo.adapters.storage.checkpoints;

import nomo.adapters.codec.{CheckpointCodec, CheckpointEncoder, SuccessorCodec, SuccessorEncoder};
import nomo.adapters.storage.session_records.commit_native;
import nomo.application.sessions.persistence.encode_record;
import nomo.application.sessions.ports.{Target, decode_record};
import nomo.domain.harness.chat.{Context, TurnResult, chat_context_error, combine, empty};
import nomo.domain.harness.loop.{ReadLedger, question_error};
import nomo.domain.harness.read.read_ledger_error;
import nomo.domain.sessions.checkpoints.{
    Checkpoint,
    CheckpointRecord,
    Identity,
    Successor,
    SuccessorRecord,
    checkpoint_validate,
    identity_error,
    restore,
    successor_validate
};
import std.memory.{MemoryEntry, MemoryVersion, Missing, WriteCondition};

flow harness_checkpoint_store_key(identity: Identity) -> string {
    return "checkpoint:" + identity.id;
}

flow harness_checkpoint_store_read(name: string) -> Option<MemoryEntry<string, CheckpointRecord>> {
    return Checkpoints.Rows.get_entry(name);
}

// Exactly one attempt, durable receipt and committed-version readback. Unknown
// is not absence and does not authorize a retry or a second model execution.
flow harness_checkpoint_store_write(name: string, row: CheckpointRecord, condition: WriteCondition) -> Result<
    MemoryVersion,
    string
> ![Memory, Error<StorageError>, Error<IndexError>] {
    return commit_native<CheckpointRecord>(
        Checkpoints.Rows,
        Target {
            store = ["Rows"],
            region = "nomo-harness-checkpoint-v1",
            key = name,
            label = "checkpoint"
        },
        row,
        condition
    );
}

flow owner(identity: Identity, phase: string) -> Result<MemoryEntry<string, CheckpointRecord>, string> {
    let invalid = identity_error(identity);
    if invalid != "" {
        return Err(invalid);
    }
    let entry = match harness_checkpoint_store_read("owner") {
        Some(value) => value,
        None() => {
            return Err("checkpoint store is not initialized");
        }
    };
    if entry.key != "owner" || entry.value.format != 1 || entry.value.phase != phase
        || entry.value.identity != identity || entry.value.body != "" {
        return Err("checkpoint owner or phase mismatch; no retry");
    }
    return Ok(entry);
}

// The caller provisions a fresh exclusive project-owned directory. Existing
// ownership is never adopted, overwritten, repaired or silently reinitialized.
public flow initialize(identity: Identity) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let invalid = identity_error(identity);
    if invalid != "" {
        return Err(invalid);
    }
    match harness_checkpoint_store_read("owner") {
        Some(_) => {
            return Err("checkpoint store already claimed");
        }
        None() => (),
    }
    match harness_checkpoint_store_read(harness_checkpoint_store_key(identity)) {
        Some(_) => {
            return Err("checkpoint row already exists");
        }
        None() => (),
    }
    let row = CheckpointRecord {
        format = 1,
        phase = "ready",
        identity,
        body = ""
    };
    return match harness_checkpoint_store_write("owner", row, Missing) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

// Consume ownership before the first inference. A failed/aborted turn cannot
// obtain a fresh allocation by calling save again in this namespace.
public flow begin(identity: Identity) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let before = match owner(identity, "ready") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match harness_checkpoint_store_read(harness_checkpoint_store_key(identity)) {
        Some(_) => {
            return Err("checkpoint row already exists");
        }
        None() => (),
    }
    let row = CheckpointRecord {
        format = 1,
        phase = "claimed",
        identity,
        body = ""
    };
    return match harness_checkpoint_store_write("owner", row, WriteCondition.Match(before.version)) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow harness_checkpoint_store_publish(saved: Checkpoint) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    match checkpoint_validate(saved, saved.identity) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let body = match encode_record(CheckpointEncoder {}, saved) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match owner(saved.identity, "claimed") {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let name = harness_checkpoint_store_key(saved.identity);
    match harness_checkpoint_store_read(name) {
        Some(_) => {
            return Err("checkpoint row already exists");
        }
        None() => (),
    }
    let pending = CheckpointRecord {
        format = 1,
        phase = "pending",
        identity = saved.identity,
        body
    };
    let version = match harness_checkpoint_store_write(name, pending, Missing) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let complete = CheckpointRecord {
        format = 1,
        phase = "published",
        identity = saved.identity,
        body
    };
    let committed = match harness_checkpoint_store_write(name, complete, WriteCondition.Match(version)) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if committed.opaque == version.opaque {
        return Err("checkpoint publication version did not change");
    }
    return Ok(true);
}

// Data only: this callgraph contains no model, File or Memory mutation action.
public flow binding(identity: Identity) -> Result<Binding, string> {
    match owner(identity, "claimed") {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let name = harness_checkpoint_store_key(identity);
    let before = match harness_checkpoint_store_read(name) {
        Some(value) => value,
        None() => {
            return Err("checkpoint missing; no completed save");
        }
    };
    let row = before.value;
    if before.key != name || row.format != 1 || row.identity != identity {
        return Err("checkpoint identity or format mismatch");
    }
    if row.phase != "published" {
        return Err("checkpoint not published; no recovery or retry");
    }
    let saved = match decode_record(CheckpointCodec {}, row.body) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let checked = match checkpoint_validate(saved, identity) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let after = match harness_checkpoint_store_read(name) {
        Some(value) => value,
        None() => {
            return Err("checkpoint disappeared during show");
        }
    };
    if after.version.opaque != before.version.opaque || after.value != row {
        return Err("checkpoint changed during show");
    }
    return Ok(Binding {
        checkpoint = checked,
        version = before.version,
        body = row.body
    });
}

public flow harness_checkpoint_store_reload(identity: Identity) -> Result<Checkpoint, string> {
    return match binding(identity) {
        Ok(value) => Ok(value.checkpoint),
        Err(error) => Err(error)
    };
}

flow admission(identity: Identity) -> string {
    return "admission:" + identity.id;
}

flow harness_successor_store_key(identity: Identity) -> string {
    return "successor:" + identity.id;
}

flow harness_successor_store_read(name: string) -> Option<MemoryEntry<string, SuccessorRecord>> {
    return Successors.Rows.get_entry(name);
}

flow harness_successor_store_write(
    name: string,
    row: SuccessorRecord,
    condition: WriteCondition
) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return commit_native<SuccessorRecord>(
        Successors.Rows,
        Target {
            store = ["Rows"],
            region = "nomo-harness-successor-v1",
            key = name,
            label = "successor"
        },
        row,
        condition
    );
}

flow row(ticket: Ticket, phase: string, body: string, usage: ReadLedger, resolved: bool) -> SuccessorRecord {
    let before = ticket.predecessor;
    let reserved = if resolved {
        ReadLedger {
            steps = 0,
            calls = 0,
            tokens = 0,
            tools = 0,
            scan = 0
        }
    }
    else {
        ReadLedger {
            steps = 7,
            calls = 4,
            tokens = 8192,
            tools = 1,
            scan = 4096
        }
    };
    return SuccessorRecord {
        format = 1,
        phase,
        predecessor = before.checkpoint.identity,
        successor = ticket.successor,
        predecessor_version = before.version.opaque,
        predecessor_body = before.body,
        request = ticket.request,
        body,
        usage,
        maximum = before.checkpoint.maximum,
        reserved,
        admitted = 2,
        resolved
    };
}

flow unchanged(before: Binding) -> string {
    let after = match binding(before.checkpoint.identity) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    if before != after {
        return "predecessor version or body changed; no retry";
    }
    return "";
}

flow claim(ticket: Ticket) -> Result<MemoryEntry<string, SuccessorRecord>, string> {
    let before = match harness_successor_store_read(admission(ticket.predecessor.checkpoint.identity)) {
        Some(value) => value,
        None() => {
            return Err("continuation admission missing; no retry");
        }
    };
    let expected = row(ticket, "admitted", "", ticket.predecessor.checkpoint.usage, false);
    if before.value != expected || before.version.opaque != ticket.version.opaque {
        return Err("continuation admission or version changed; no retry");
    }
    return Ok(before);
}

// Missing-only admission is never deleted/reset. Its exact durable readback and
// the unchanged predecessor must both be confirmed before any Model/File call.
public flow admit(predecessor: Identity, successor: Identity, request: string) -> Result<Ticket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let invalid = identity_error(successor);
    if invalid != "" {
        return Err(invalid);
    }
    if predecessor.id == successor.id || predecessor.workspace != successor.workspace
        || predecessor.allowed != successor.allowed {
        return Err("successor lineage or workspace binding mismatch");
    }
    let invalid_request = question_error(request);
    if invalid_request != "" {
        return Err(invalid_request);
    }
    let before = match binding(predecessor) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let restored = match restore(before.checkpoint) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let plan = Context {
        phase = "plan",
        request,
        task = "",
        result = "",
        tool = "",
        outcome = "",
        allowed = predecessor.allowed,
        prior = restored.prior
    };
    let invalid_context = chat_context_error(plan);
    if invalid_context != "" {
        return Err(invalid_context);
    }
    match harness_successor_store_read(admission(predecessor)) {
        Some(_) => {
            return Err("predecessor continuation already admitted; no retry");
        }
        None() => (),
    }
    match harness_successor_store_read(harness_successor_store_key(successor)) {
        Some(_) => {
            return Err("successor row already exists; no retry");
        }
        None() => (),
    }
    let initial = Ticket {
        predecessor = before,
        successor,
        request,
        version = before.version
    };
    let version = match harness_successor_store_write(
        admission(predecessor),
        row(initial, "admitted", "", before.checkpoint.usage, false),
        Missing
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let changed = unchanged(before);
    if changed != "" {
        return Err(changed);
    }
    return Ok(Ticket {
        predecessor = before,
        successor,
        request,
        version
    });
}

// Only returned validated failures settle. Host abort/unresolved metadata leaves
// the already durable admitted row unresolved; neither path restores allowance.
public flow failed(ticket: Ticket, turn: TurnResult) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    if turn.status == 0 || !turn.resolved || turn.completed != None() || turn.state.admitted != 2
        || turn.state.maximum != ticket.predecessor.checkpoint.maximum || turn.state.prior != empty() {
        return Err("unresolved or incoherent failed continuation; admission retained");
    }
    let used = turn.state.usage;
    let prior = ticket.predecessor.checkpoint.usage;
    let local = ReadLedger {
        steps = used.steps - prior.steps,
        calls = used.calls - prior.calls,
        tokens = used.tokens - prior.tokens,
        tools = used.tools - prior.tools,
        scan = used.scan - prior.scan
    };
    let invalid = read_ledger_error(local);
    if invalid != "" {
        return Err(invalid);
    }
    let total = match combine(prior, local, turn.state.maximum) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if total != used {
        return Err("failed continuation cumulative settlement mismatch");
    }
    match claim(ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    return match harness_successor_store_write(
        admission(ticket.predecessor.checkpoint.identity),
        row(ticket, "failed", "", used, true),
        WriteCondition.Match(ticket.version)
    ) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow harness_successor_store_publish(ticket: Ticket, saved: Successor) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    match successor_validate(saved, ticket.successor, ticket.predecessor.checkpoint.identity) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    if saved.predecessor != ticket.predecessor.checkpoint
        || saved.predecessor_version != ticket.predecessor.version.opaque || saved.request != ticket.request {
        return Err("successor differs from admitted predecessor or request");
    }
    let body = match encode_record(SuccessorEncoder {}, saved) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match claim(ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let changed = unchanged(ticket.predecessor);
    if changed != "" {
        return Err(changed);
    }
    match harness_successor_store_read(harness_successor_store_key(ticket.successor)) {
        Some(_) => {
            return Err("successor already exists; no retry");
        }
        None() => (),
    }
    match harness_successor_store_write(
        admission(ticket.predecessor.checkpoint.identity),
        row(ticket, "settled", body, saved.usage, true),
        WriteCondition.Match(ticket.version)
    ) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let version = match harness_successor_store_write(
        harness_successor_store_key(ticket.successor),
        row(ticket, "pending", body, saved.usage, true),
        Missing
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let committed = match harness_successor_store_write(
        harness_successor_store_key(ticket.successor),
        row(ticket, "published", body, saved.usage, true),
        WriteCondition.Match(version)
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if committed.opaque == version.opaque {
        return Err("successor publication version did not change");
    }
    return Ok(true);
}

// Data-only show checks explicit lineage, exact admission/publication bodies and
// stable read versions. The SQLite Host may maintain its normal WAL/schema.
public flow harness_successor_store_reload(predecessor: Identity, successor: Identity) -> Result<
    Successor,
    string
> {
    let before = match binding(predecessor) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let admitted = match harness_successor_store_read(admission(predecessor)) {
        Some(value) => value,
        None() => {
            return Err("successor admission missing");
        }
    };
    let published = match harness_successor_store_read(harness_successor_store_key(successor)) {
        Some(value) => value,
        None() => {
            return Err("successor missing; no completed continuation");
        }
    };
    let saved = match decode_record(SuccessorCodec {}, published.value.body) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match successor_validate(saved, successor, predecessor) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let ticket = Ticket {
        predecessor = before,
        successor,
        request = saved.request,
        version = admitted.version
    };
    if saved.predecessor != before.checkpoint || saved.predecessor_version != before.version.opaque
        || admitted.value != row(ticket, "settled", published.value.body, saved.usage, true)
        || published.value != row(ticket, "published", published.value.body, saved.usage, true) {
        return Err("successor admission, publication or predecessor mismatch");
    }
    let admission_after = match harness_successor_store_read(admission(predecessor)) {
        Some(value) => value,
        None() => {
            return Err("admission disappeared");
        }
    };
    let after = match harness_successor_store_read(harness_successor_store_key(successor)) {
        Some(value) => value,
        None() => {
            return Err("successor disappeared");
        }
    };
    if admission_after != admitted || after != published {
        return Err("successor changed during show");
    }
    let changed = unchanged(before);
    if changed != "" {
        return Err(changed);
    }
    return Ok(saved);
}

public type Binding = {
    checkpoint: Checkpoint,
    version: MemoryVersion,
    body: string
};

public type Ticket = {
    predecessor: Binding,
    successor: Identity,
    request: string,
    version: MemoryVersion
};

alias CheckpointsSchema = MemoryRegion<{
    Rows: Store<string, CheckpointRecord>
}>;

public let Checkpoints = std.memory.region<CheckpointsSchema>(
    stable_id = "nomo-harness-checkpoint-v1",
    store = "harness-checkpoint"
);

alias SuccessorsSchema = MemoryRegion<{
    Rows: Store<string, SuccessorRecord>
}>;

public let Successors = std.memory.region<SuccessorsSchema>(
    stable_id = "nomo-harness-successor-v1",
    store = "harness-successor"
);
