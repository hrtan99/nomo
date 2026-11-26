module nomo.domain.sessions.history_followup_guard;

import std.memory.MemoryVersion;
import nomo.domain.sessions.chat_history.Entry;
import nomo.session.history_followup_guard.Record;

public type Ticket = { record: Record, version: MemoryVersion, history: Entry };
