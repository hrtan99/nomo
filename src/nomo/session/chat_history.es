module nomo.session.chat_history;

import nomo.core.conversation.Event;
import nomo.session.chat_session_contract.Session;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// Versions 1 and 2 are retained for existing sessions. Version 3 atomically stores
// the same chat checkpoint together with bounded redacted event metadata.
public type Frame = { format: i32, chat: Session, first_count: usize, events: Array<Event> };

alias LegacySchema = MemoryRegion<{ Rows: Store<string, Session> }>;

alias FrameSchema = MemoryRegion<{ Rows: Store<string, Frame> }>;

public let Legacy = std.memory.region<LegacySchema>(stable_id = "nomo-chat-history-v1", store = "chat-history");

public let Frames = std.memory.region<FrameSchema>(stable_id = "nomo-chat-history-v3", store = "chat-history-v3");
