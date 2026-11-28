module nomo.session.history_followup_check_guard;

import nomo.session.history_check_store.Record;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Checks = std.memory.region<Schema>(stable_id = "nomo-followup-check-v1", store = "followup-check");
