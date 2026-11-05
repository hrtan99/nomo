module nomo.session.session_store;

import std.memory.{Missing, MemoryVersion};
import nomo.session.session_state.{Snapshot, Request, Projection, validate};
import nomo.session.store_record.{Record, valid_id, session_key, pending, published, bundle, restore};
import nomo.session.metadata_store.{read, write, publish};
import nomo.session.history_store.{empty, append, load};
import nomo.session.bundle_codec.encode;

// Shared metadata/history publication tail. The caller must already own the
// exact current metadata version; unknown writes are never retried.
public flow publish_snapshot(saved: Snapshot, save_id: string, expected: Record, version: MemoryVersion, continuation: bool) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let next = published(pending(saved, save_id));
    let body = bundle(saved, save_id);
    match encode(body) { Err(error) => { return Err(error); } Ok(_) => {} }
    match append(next.session_key, body) { Err(error) => { return Err(error); } Ok(_) => {} }
    let observed = match load(next.session_key) { Ok(value) => value, Err(error) => { return Err(error); } };
    let restored = match restore(next, observed) { Ok(value) => value, Err(error) => { return Err(error); } };
    if observed != body { return Err(if continuation { "successor bundle differs from intent" } else { "appended bundle differs from intent" }); }
    if restored != saved { return Err(if continuation { "successor bundle differs from intent" } else { "history and metadata disagree" }); }
    let current = match read(saved.session_id) { Some(value) => value, None() => { return Err(if continuation { "admission missing" } else { "pending metadata missing" }); } };
    if current.value != expected || current.version.opaque != version.opaque { return Err(if continuation { "admission changed" } else { "pending metadata changed" }); }
    return match publish(next, version) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

// Only a new ID in a fixture-provisioned empty namespace; no update, retry or repair.
public flow save(saved: Snapshot, requested: Request, save_id: string) -> Result<Projection, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if !valid_id(save_id) { return Err("invalid save identity"); }
    let projection = match validate(saved, requested) { Ok(value) => value, Err(error) => { return Err(error); } };
    let body = bundle(saved, save_id);
    match encode(body) { Err(error) => { return Err(error); } Ok(_) => {} }
    match read(saved.session_id) { Some(_) => { return Err("session metadata already exists"); } None() => {} }
    let row = pending(saved, save_id);
    if !empty(row.session_key) { return Err("session history is not empty"); }
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    // Only this confirmed intent permits the sole append. Unknown stops above.
    match publish_snapshot(saved, save_id, row, version, false) { Ok(_) => {} Err(error) => { return Err(error); } }
    return Ok(projection);
}

// Fresh readback resolves only current published data, never an automatic repair.
public flow reload(requested: Request, save_id: string) -> Result<Projection, string> {
    if !valid_id(requested.session_id) || !valid_id(save_id) { return Err("invalid requested identity"); }
    let before = match read(requested.session_id) { Some(value) => value, None() => { return Err("session metadata missing"); } };
    let row = before.value;
    if row.format != 1 || row.snapshot.session_id != requested.session_id || row.save_id != save_id ||
        row.session_key != session_key(requested.session_id, save_id) { return Err("metadata identity mismatch"); }
    if row.phase == "pending" { return Err("pending save; recovery required; no retry"); }
    if row.phase != "published" { return Err("invalid metadata phase"); }
    let body = match load(row.session_key) { Ok(value) => value, Err(error) => { return Err(error); } };
    let saved = match restore(row, body) { Ok(value) => value, Err(error) => { return Err(error); } };
    let after = match read(requested.session_id) { Some(value) => value, None() => { return Err("metadata disappeared"); } };
    if after.version.opaque != before.version.opaque || after.value != row { return Err("metadata changed during reload"); }
    return validate(saved, requested);
}
