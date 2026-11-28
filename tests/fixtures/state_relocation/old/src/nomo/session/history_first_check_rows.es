module nomo.session.history_first_check_rows;

import nomo.session.history_check_store.Record;

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Checks = std.memory.region<Schema>(stable_id = "nomo-history-check-v1", store = "history-check");
