module nomo.session.recoverable_events;

import nomo.core.conversation.Event;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// A pure, bounded projection. This does not persist events or grant authority.
// Exact known-literal filtering is not comprehensive secret detection; callers
// must supply an appropriate trusted policy before using any persisted form.
public type Frame = {
    format: i32,
    turns: i32,
    first_count: usize,
    events: Array<Event>
};
