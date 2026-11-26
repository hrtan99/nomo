module nomo.domain.sessions.recoverable_work_store;

import std.memory.{MemoryEntry, MemoryVersion};
import nomo.session.recoverable_chat_store.Frame as ChatFrame;
import nomo.session.recoverable_work_store.Frame;

public type Ticket = { frame: Frame, version: MemoryVersion, chat: MemoryEntry<string, ChatFrame> };
