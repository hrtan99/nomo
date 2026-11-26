module nomo.adapters.storage.legacy.metadata_store;

import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_receipt;
import std.memory.{WriteCondition, MemoryVersion, MemoryEntry};
import nomo.session.store_record.Record;
import nomo.session.metadata_store.Metadata;

public flow read(id: string) -> Option<MemoryEntry<string, Record>> { return Metadata.Rows.get_entry(id); }

// Transition only against the observed/confirmed version, then verify the receipt's
// committed version and exact row. Unknown/refused writes return without retry.
public flow publish(row: Record, expected: MemoryVersion) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let committed = match write(row, std.memory.WriteCondition.Match(expected)) {
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
