module nomo.domain.sessions.history_work_guard;

import std.memory.MemoryVersion;
import nomo.domain.sessions.chat_history.Entry;
import nomo.session.history_work_guard.Record;

public type Ticket = { record: Record, version: MemoryVersion, history: Entry };
