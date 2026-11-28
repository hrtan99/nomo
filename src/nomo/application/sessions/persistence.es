module nomo.application.sessions.persistence;

import nomo.application.sessions.ports.{CasRows, RecordEncoder, Submission, Target};
import std.memory.{MemoryVersion, MemoryWriteChange, StorageDurability, WriteCondition, WriteOutcome};

public flow encode_record<T, E ~ RecordEncoder<T>>(encoder: E, value: T) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
    return encoder.encode(value);
}

// Exactly one native commit. Unknown and refusal are domain outcomes; native
// failures escape. There is no retry or compensation after an uncertain write.
public flow commit_once<Row, S ~ CasRows<Row>>(rows: S, value: Row, condition: WriteCondition, previous: Option<MemoryVersion>) -> Result<MemoryVersion, string> {
    let target = rows.target();
    let attempt = rows.submit(value, condition);
    let version = match committed_version(target, attempt) { Ok(value) => value, Err(error) => { return Err(error); } };
    let after = match rows.read() { Ok(Some(item)) => item, _ => { return Err(target.label + " readback missing"); } };
    if after.key != target.key || !rows.same(after.value, value) || after.version.opaque != version.opaque { return Err(target.label + " readback mismatch; no retry"); }
    match previous { Some(item) => { if item.opaque == version.opaque { return Err(target.label + " version did not change"); } }, None() => (), }
    return Ok(version);
}

// Shared receipt validation for behavioral adapters and direct native stores.
public flow committed_version(target: Target, attempt: Submission) -> Result<MemoryVersion, string> ![] {
    let operation = attempt.operation;
    let receipt = match attempt.outcome {
        WriteOutcome.Unknown(_) => { return Err(target.label + " commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err(target.label + " commit refused; no retry"); }
        WriteOutcome.Committed(item) => item,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != target.key || receipt.target.region != target.region || receipt.target.store != target.store { return Err(target.label + " receipt mismatch; no retry"); }
    match receipt.durability { StorageDurability.Durable() => (), _ => { return Err("durable SQLite " + target.label + " receipt required"); } }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err(target.label + " version missing"); } };
    return Ok(version);
}
