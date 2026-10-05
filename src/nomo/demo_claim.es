module nomo.demo_claim;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability};

public type Claim = { format: i32, phase: string, session_id: string, save_id: string, binding: string,
    maximum: i32, budget: i32 };
alias Schema = MemoryRegion<{ Claims: Store<string, Claim> }>;
let Demo = std.memory.region<Schema>(stable_id = "nomo-session-demo-v1", store = "session-demo");

public flow read_claim() -> Option<MemoryEntry<string, Claim>> { return get_entry(Demo.Claims, "single-demo"); }

// Exact durable receipt and committed-version readback; no retry or reconciliation.
public flow write_claim(value: Claim, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let intent = prepare_put(Demo.Claims, "single-demo", value, condition);
    let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("demo initialization unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("demo initialization refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "single-demo" || receipt.target.region != "nomo-session-demo-v1" ||
        receipt.target.store != ["Claims"] { return Err("demo receipt mismatch"); }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite demo receipt required"); }
    let committed = match receipt.change { MemoryWriteChange.Written(version) => version, _ => { return Err("demo write receipt required"); } };
    let observed = match read_claim() { Some(entry) => entry, None() => { return Err("demo claim missing after commit"); } };
    if observed.key != "single-demo" || observed.value != value || observed.version.opaque != committed.opaque {
        return Err("demo claim readback mismatch");
    }
    return Ok(committed);
}
