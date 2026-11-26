module nomo.domain.sessions.chat_history;

import std.memory.MemoryVersion;
import nomo.core.conversation.Event;
import nomo.session.chat_session_contract.Session;

public type Entry = { key: string, value: Session, version: MemoryVersion, first_count: usize, events: Array<Event>, schema: i32, pending: bool };
