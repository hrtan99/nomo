module nomo.session.event_history;

import nomo.core.conversation.Event;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// Only a trusted caller's known literals are redacted. No policy or literal is
// stored here. This isolated store is not yet linked atomically to chat turns.
public type History = { format: i32, turns: i32, first_count: usize, events: Array<Event> };

alias Schema = MemoryRegion<{ Rows: Store<string, History> }>;

public let EventStore = std.memory.region<Schema>(stable_id = "nomo-event-history-v1", store = "event-history");
