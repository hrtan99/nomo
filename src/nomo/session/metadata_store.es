module nomo.session.metadata_store;

import nomo.session.cas_rows.{Target, commit_receipt};

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry};
import nomo.session.store_record.Record;

alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Metadata = std.memory.region<Schema>(stable_id = "nomo-session-store-v1", store = "session");

public flow read(id: string) -> Option<MemoryEntry<string, Record>> { return get_entry(Metadata.Rows, id); }

// Transition only against the observed/confirmed version, then verify the receipt's
// committed version and exact row. Unknown/refused writes return without retry.
public flow publish(row: Record, expected: MemoryVersion) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let committed = match write(row, std.memory.Match(expected)) {
        Ok(version) => version, Err(error) => { return Err(error); }
    };
    let observed = match read(row.snapshot.session_id) {
        Some(value) => value, None() => { return Err("published metadata missing"); }
    };
    if observed.key != row.snapshot.session_id || observed.value != row ||
        observed.version.opaque == expected.opaque || observed.version.opaque != committed.opaque {
        return Err("published metadata readback mismatch");
    }
    return Ok(observed.version);
}

// A confirmed Memory mutation is not proof of Session content or effect completion.
public flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    return commit_receipt<Record>(Metadata.Rows, Target { store = ["Rows"], region = "nomo-session-store-v1", key = row.snapshot.session_id, label = "metadata" }, row, condition);
}
