module nomo.session.cas_rows;

import std.memory.{get_entry, prepare_put, operation_ref, commit, MemoryEntry, MemoryVersion, MemoryWriteReceipt, MemoryWriteRejection, StorageOperationRef, WriteCondition, WriteOutcome, MemoryWriteChange, StorageDurability};

public type Target = { region: string, store: Array<string>, key: string, label: string };
public type Submission = { operation: StorageOperationRef, outcome: WriteOutcome<MemoryWriteReceipt<string>, MemoryWriteRejection> };
public spec CasRows<Row> {
    flow target(self) -> Target ![];
    flow submit(self, value: Row, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>];
    flow read(self) -> Result<Option<MemoryEntry<string, Row>>, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow same(self, left: Row, right: Row) -> bool ![];
}

// Shared receipt validation for behavioral adapters and direct native stores.
flow committed_version(target: Target, attempt: Submission) -> Result<MemoryVersion, string> ![] {
    let operation = attempt.operation;
    let receipt = match attempt.outcome {
        WriteOutcome.Unknown(_) => { return Err(target.label + " commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err(target.label + " commit refused; no retry"); }
        WriteOutcome.Committed(item) => item,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != target.key || receipt.target.region != target.region || receipt.target.store != target.store { return Err(target.label + " receipt mismatch; no retry"); }
    match receipt.durability { StorageDurability.SqliteWalFull() => {} _ => { return Err("durable SQLite " + target.label + " receipt required"); } }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err(target.label + " version missing"); } };
    return Ok(version);
}

// Exactly one native commit. Unknown and refusal are domain outcomes; native
// failures escape. There is no retry or compensation after an uncertain write.
public flow commit_once<Row, S ~ CasRows<Row>>(rows: S, value: Row, condition: WriteCondition, previous: Option<MemoryVersion>) -> Result<MemoryVersion, string> {
    let target = rows.target();
    let attempt = rows.submit(value, condition);
    let version = match committed_version(target, attempt) { Ok(value) => value, Err(error) => { return Err(error); } };
    let after = match rows.read() { Ok(Some(item)) => item, _ => { return Err(target.label + " readback missing"); } };
    if after.key != target.key || !rows.same(after.value, value) || after.version.opaque != version.opaque { return Err(target.label + " readback mismatch; no retry"); }
    match previous { Some(item) => { if item.opaque == version.opaque { return Err(target.label + " version did not change"); } } None() => {} }
    return Ok(version);
}

// A typed Store is forwarded intact. Prepare and commit stay in this flow so
// the native intent never crosses a generic return boundary.
public flow commit_native<Row>(store: Store<string, Row>, target: Target, value: Row, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let version = match commit_receipt(store, target, value, condition) { Ok(item) => item, Err(error) => { return Err(error); } };
    let after = match get_entry(store, target.key) { Some(item) => item, None() => { return Err(target.label + " readback missing"); } };
    if after.key != target.key || after.value != value || after.version.opaque != version.opaque { return Err(target.label + " readback mismatch; no retry"); }
    return Ok(version);
}

public flow submit_native<Row>(store: Store<string, Row>, key: string, value: Row, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] {
    let intent = prepare_put(store, key, value, condition);
    return Submission { operation = operation_ref(intent), outcome = commit(intent) };
}

// Namespace-specific consumers retain their own readback and transition checks.
public flow commit_receipt<Row>(store: Store<string, Row>, target: Target, value: Row, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    return committed_version(target, submit_native(store, target.key, value, condition));
}
