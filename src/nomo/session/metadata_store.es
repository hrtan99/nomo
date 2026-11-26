module nomo.session.metadata_store;

import nomo.session.store_record.Record;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;

public let Metadata = std.memory.region<Schema>(stable_id = "nomo-session-store-v1", store = "session");
