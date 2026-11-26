module nomo.domain.sessions.work_chain_journal;

import std.memory.MemoryVersion;
import nomo.session.work_chain_journal.Record;

public type Ticket = { row: Record, version: MemoryVersion };
