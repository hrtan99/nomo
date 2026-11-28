module nomo.session.event_history;

import nomo.core.conversation.Event;

public type History = {
    format: i32,
    turns: i32,
    first_count: usize,
    events: Array<Event>
};

alias Schema = MemoryRegion<{
    Rows: Store<string, History>
}>;

public let EventStore = std.memory.region<Schema>(
    stable_id = "nomo-event-history-v1",
    store = "event-history"
);
