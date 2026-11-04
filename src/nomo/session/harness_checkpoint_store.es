module nomo.session.harness_checkpoint_store;

import nomo.session.cas_rows.{Target, commit_native};
import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry, Missing, Match};
import nomo.session.harness_checkpoint.{Identity, Checkpoint, identity_error, validate, encode, decode};

public type Record = { format: i32, phase: string, identity: Identity, body: string };
public type Binding = { checkpoint: Checkpoint, version: MemoryVersion, body: string };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Checkpoints = std.memory.region<Schema>(stable_id = "nomo-harness-checkpoint-v1", store = "harness-checkpoint");

flow key(identity: Identity) -> string { return "checkpoint:" + identity.id; }
flow read(name: string) -> Option<MemoryEntry<string, Record>> { return get_entry(Checkpoints.Rows, name); }

// Exactly one attempt, durable receipt and committed-version readback. Unknown
// is not absence and does not authorize a retry or a second model execution.
flow write(name: string, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return commit_native<Record>(Checkpoints.Rows, Target { store = ["Rows"], region = "nomo-harness-checkpoint-v1", key = name, label = "checkpoint" }, row, condition);
}

flow owner(identity: Identity, phase: string) -> Result<MemoryEntry<string, Record>, string> {
    let invalid = identity_error(identity); if invalid != "" { return Err(invalid); }
    let entry = match read("owner") { Some(value) => value, None() => { return Err("checkpoint store is not initialized"); } };
    if entry.key != "owner" || entry.value.format != 1 || entry.value.phase != phase ||
        entry.value.identity != identity || entry.value.body != "" { return Err("checkpoint owner or phase mismatch; no retry"); }
    return Ok(entry);
}

// The caller provisions a fresh exclusive project-owned directory. Existing
// ownership is never adopted, overwritten, repaired or silently reinitialized.
public flow initialize(identity: Identity) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let invalid = identity_error(identity); if invalid != "" { return Err(invalid); }
    match read("owner") { Some(_) => { return Err("checkpoint store already claimed"); } None() => {} }
    match read(key(identity)) { Some(_) => { return Err("checkpoint row already exists"); } None() => {} }
    let row = Record { format = 1, phase = "ready", identity = identity, body = "" };
    return match write("owner", row, Missing) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

// Consume ownership before the first inference. A failed/aborted turn cannot
// obtain a fresh allocation by calling save again in this namespace.
public flow begin(identity: Identity) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match owner(identity, "ready") { Ok(value) => value, Err(error) => { return Err(error); } };
    match read(key(identity)) { Some(_) => { return Err("checkpoint row already exists"); } None() => {} }
    let row = Record { format = 1, phase = "claimed", identity = identity, body = "" };
    return match write("owner", row, Match(before.version)) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

public flow publish(saved: Checkpoint) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match validate(saved, saved.identity) { Ok(_) => {} Err(error) => { return Err(error); } }
    let body = match encode(saved) { Ok(value) => value, Err(error) => { return Err(error); } };
    match owner(saved.identity, "claimed") { Ok(_) => {} Err(error) => { return Err(error); } }
    let name = key(saved.identity);
    match read(name) { Some(_) => { return Err("checkpoint row already exists"); } None() => {} }
    let pending = Record { format = 1, phase = "pending", identity = saved.identity, body = body };
    let version = match write(name, pending, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    let complete = Record { format = 1, phase = "published", identity = saved.identity, body = body };
    let committed = match write(name, complete, Match(version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if committed.opaque == version.opaque { return Err("checkpoint publication version did not change"); }
    return Ok(true);
}

// Data only: this callgraph contains no model, File or Memory mutation action.
public flow binding(identity: Identity) -> Result<Binding, string> {
    match owner(identity, "claimed") { Ok(_) => {} Err(error) => { return Err(error); } }
    let name = key(identity);
    let before = match read(name) { Some(value) => value, None() => { return Err("checkpoint missing; no completed save"); } };
    let row = before.value;
    if before.key != name || row.format != 1 || row.identity != identity { return Err("checkpoint identity or format mismatch"); }
    if row.phase != "published" { return Err("checkpoint not published; no recovery or retry"); }
    let saved = match decode(row.body) { Ok(value) => value, Err(error) => { return Err(error); } };
    let checked = match validate(saved, identity) { Ok(value) => value, Err(error) => { return Err(error); } };
    let after = match read(name) { Some(value) => value, None() => { return Err("checkpoint disappeared during show"); } };
    if after.version.opaque != before.version.opaque || after.value != row { return Err("checkpoint changed during show"); }
    return Ok(Binding { checkpoint = checked, version = before.version, body = row.body });
}

public flow reload(identity: Identity) -> Result<Checkpoint, string> {
    return match binding(identity) { Ok(value) => Ok(value.checkpoint), Err(error) => Err(error) };
}
