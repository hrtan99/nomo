module nomo.adapters.storage.legacy.demo_claim;

import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_native;
import std.memory.{WriteCondition, MemoryVersion, MemoryEntry};
import nomo.session.demo_claim.{Claim, Demo};

public flow read_claim() -> Option<MemoryEntry<string, Claim>> { return Demo.Claims.get_entry("single-demo"); }

// Exact durable receipt and committed-version readback; no retry or reconciliation.
public flow write_claim(value: Claim, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    return commit_native<Claim>(Demo.Claims, Target { store = ["Claims"], region = "nomo-session-demo-v1", key = "single-demo", label = "demo" }, value, condition);
}
