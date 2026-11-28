module nomo.session.recoverable_events;

import nomo.core.conversation.Event;

public type Frame = {
    format: i32,
    turns: i32,
    first_count: usize,
    events: Array<Event>
};
