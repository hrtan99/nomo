module nomo.domain.sessions.work_record_store;

import std.memory.MemoryVersion;
import nomo.session.work_record.Record;

public type Ticket = { row: Record, version: MemoryVersion };
