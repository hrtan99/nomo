module nomo.session.recoverable_check_store;

import nomo.session.check_store.Frame;

alias Schema = MemoryRegion<{
    Rows: Store<string, Frame>
}>;

public let Checks = std.memory.region<Schema>(
    stable_id = "nomo-recoverable-check-v1",
    store = "recoverable-check"
);
