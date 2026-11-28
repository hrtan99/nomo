module nomo.session.work_record_store;

import nomo.session.work_record.Record;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Work = std.memory.region<Schema>(stable_id = "nomo-work-record-v1", store = "work-record");
