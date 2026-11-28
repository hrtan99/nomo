module nomo.session.recoverable_followup_check_store;

import nomo.session.check_store.Frame;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

alias Schema = MemoryRegion<{
    Rows: Store<string, Frame>
}>;

public let Checks = std.memory.region<Schema>(
    stable_id = "nomo-recoverable-followup-check-v1",
    store = "recoverable-followup-check"
);
