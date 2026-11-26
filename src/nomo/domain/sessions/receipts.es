module nomo.domain.sessions.receipts;

import std.memory.{MemoryVersion, WriteOutcome, MemoryWriteChange, StorageDurability};
import nomo.domain.sessions.cas_rows.{Target, Submission};

// Shared receipt validation for behavioral adapters and direct native stores.
public flow committed_version(target: Target, attempt: Submission) -> Result<MemoryVersion, string> ![] {
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
