module nomo.session.metadata_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability};
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
    let intent = prepare_put(Metadata.Rows, row.snapshot.session_id, row, condition);
    let operation = operation_ref(intent);
    match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("metadata commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("metadata commit refused; no retry"); }
        WriteOutcome.Committed(receipt) => {
            if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
                receipt.target.key != row.snapshot.session_id || receipt.target.region != "nomo-session-store-v1" ||
                receipt.target.store != ["Rows"] { return Err("metadata receipt mismatch"); }
            let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
            if !durable { return Err("durable SQLite receipt required"); }
            return match receipt.change { MemoryWriteChange.Written(version) => Ok(version), _ => Err("metadata write receipt required") };
        }
    }
}
