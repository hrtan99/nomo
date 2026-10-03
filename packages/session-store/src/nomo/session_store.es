module nomo.session_store;

import std.memory.Missing;
import nomo.session_state.{Snapshot, Request, Projection, validate};
import nomo.store_record.{valid_id, session_key, pending, published, bundle, restore};
import nomo.metadata_store.{read, write, publish};
import nomo.history_store.{empty, append, load};
import nomo.bundle_codec.encode;

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
    match append(row.session_key, body) { Err(error) => { return Err(error); } Ok(_) => {} }
    let observed = match load(row.session_key) { Ok(value) => value, Err(error) => { return Err(error); } };
    if observed != body { return Err("appended bundle differs from intent"); }
    let restored = match restore(row, observed) { Ok(value) => value, Err(error) => { return Err(error); } };
    if restored != saved { return Err("history and metadata disagree"); }
    let current = match read(saved.session_id) { Some(value) => value, None() => { return Err("pending metadata missing"); } };
    if current.version.opaque != version.opaque || current.value != row { return Err("pending metadata changed"); }
    match publish(published(row), version) { Err(error) => { return Err(error); } Ok(_) => {} }
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
