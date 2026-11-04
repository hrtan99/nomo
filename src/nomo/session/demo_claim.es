module nomo.session.demo_claim;

import nomo.session.cas_rows.{Target, commit_native};

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry};

public type Claim = { format: i32, phase: string, session_id: string, save_id: string, binding: string,
    maximum: i32, budget: i32 };
alias Schema = MemoryRegion<{ Claims: Store<string, Claim> }>;
let Demo = std.memory.region<Schema>(stable_id = "nomo-session-demo-v1", store = "session-demo");

public flow read_claim() -> Option<MemoryEntry<string, Claim>> { return get_entry(Demo.Claims, "single-demo"); }

// Exact durable receipt and committed-version readback; no retry or reconciliation.
public flow write_claim(value: Claim, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    return commit_native<Claim>(Demo.Claims, Target { store = ["Claims"], region = "nomo-session-demo-v1", key = "single-demo", label = "demo" }, value, condition);
}
