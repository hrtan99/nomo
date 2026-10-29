module nomo.agent.conversation_events;

import nomo.core.conversation.{State, Event, add, capacity_error, stop};
import nomo.model.conversation_output.ConversationOutput;

public type Turn = { state: State, status: i32 };

public flow emit(state: State, role: string, kind: string, name: string, text: string) -> State {
    let event = Event { role = role, kind = kind, name = name, text = text };
    let updated = add(state, event);
    perform ConversationOutput.publish(event);
    return updated;
}

public flow failure(state: State, message: string, status: i32) -> Turn {
    return Turn { state = emit(state, "error", "error", "", message), status = status };
}

public flow reject(state: State, message: string) -> Turn {
    let full = capacity_error(state, 1, 64);
    if full != "" { return failure(stop(state), full, 4); }
    return failure(state, message, 2);
}

