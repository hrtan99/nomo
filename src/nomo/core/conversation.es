module nomo.core.conversation;

import std.collections.len;
import std.text.len as text_len;

public type Event = { role: string, kind: string, name: string, text: string };
public type State = { events: Array<Event>, characters: usize, spent: i32, stopped: bool };

public flow fresh() -> State {
    let events: Array<Event> = [];
    return State { events = events, characters = 0, spent = 0, stopped = false };
}

// Always preserve one event and 64 characters for a capacity terminal error.
public flow capacity_error(state: State, slots: usize, characters: usize) -> string {
    if len(state.events) + slots + 1 > 32 { return "history event capacity exhausted; start a new invocation"; }
    if state.characters + characters + 64 > 262144 { return "history content capacity exhausted; start a new invocation"; }
    return "";
}

public flow add(state: State, event: Event) -> State {
    return State { events = state.events.push(event),
        characters = state.characters + text_len(event.name) + text_len(event.text),
        spent = state.spent, stopped = state.stopped };
}

public flow charge(state: State) -> State {
    return State { events = state.events, characters = state.characters, spent = state.spent + 1, stopped = state.stopped };
}

public flow stop(state: State) -> State {
    return State { events = state.events, characters = state.characters, spent = state.spent, stopped = true };
}
