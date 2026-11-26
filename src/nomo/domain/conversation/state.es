module nomo.domain.conversation.state;

import nomo.domain.context.large_context.history_bytes;
import std.text.char_count as text_len;
import nomo.core.conversation.{Event, State};

public flow fresh() -> State {
    let events: Array<Event> = [];
    return State { events, characters = 0, spent = 0, stopped = false };
}

// Always preserve one event and 64 characters for a capacity terminal error.
public flow capacity_error(state: State, slots: usize, characters: usize) -> string {
    if state.events.len() + slots + 1 > 32 { return "history event capacity exhausted; start a new invocation"; }
    if state.characters + characters + 64 > history_bytes() { return "history content capacity exhausted; start a new invocation"; }
    return "";
}

public flow add(state: State, event: Event) -> State {
    return state { events = state.events.push(event), characters = state.characters + text_len(event.name) + text_len(event.text) };
}

public flow charge(state: State) -> State {
    return state { spent = state.spent + 1 };
}

public flow stop(state: State) -> State {
    return state { stopped = true };
}
