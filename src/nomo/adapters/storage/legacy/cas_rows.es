module nomo.adapters.storage.legacy.cas_rows;

import std.memory.{StorageData, MemoryVersion, WriteCondition};
import nomo.domain.sessions.cas_rows.{Target, Submission};
import nomo.domain.sessions.receipts.committed_version;

// A typed Store is forwarded intact. Prepare and commit stay in this flow so
// the native intent never crosses a generic return boundary.
public flow commit_native<Row ~ StorageData>(store: Store<string, Row>, target: Target, value: Row, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let version = match commit_receipt(store, target, value, condition) { Ok(item) => item, Err(error) => { return Err(error); } };
    let after = match store.get_entry(target.key) { Some(item) => item, None() => { return Err(target.label + " readback missing"); } };
    if after.key != target.key || after.value != value || after.version.opaque != version.opaque { return Err(target.label + " readback mismatch; no retry"); }
    return Ok(version);
}

public flow submit_native<Row ~ StorageData>(store: Store<string, Row>, key: string, value: Row, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] {
    let intent = store.prepare_put(key, value, condition);
    return Submission { operation = intent.operation_ref(), outcome = intent.commit() };
}

// Namespace-specific consumers retain their own readback and transition checks.
public flow commit_receipt<Row ~ StorageData>(store: Store<string, Row>, target: Target, value: Row, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    return committed_version(target, submit_native(store, target.key, value, condition));
}
