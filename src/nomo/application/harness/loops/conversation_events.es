module nomo.application.harness.loops.conversation_events;

import nomo.core.conversation.{State, Event};
import nomo.domain.conversation.state.{add, capacity_error, stop};
import nomo.application.harness.effects.model_conversation_output.ConversationOutput;
import nomo.domain.harness.conversation_events.Turn;

public flow emit(state: State, role: string, kind: string, name: string, text: string) -> State {
    let event = Event { role, kind, name, text };
    let updated = add(state, event);
    perform ConversationOutput.publish(event);
    return updated;
}

public flow failure(state: State, message: string, status: i32) -> Turn {
    return Turn { state = emit(state, "error", "error", "", message), status };
}

public flow reject(state: State, message: string) -> Turn {
    let full = capacity_error(state, 1, 64);
    if full != "" { return failure(stop(state), full, 4); }
    return failure(state, message, 2);
}
