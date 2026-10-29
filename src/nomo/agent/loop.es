module nomo.agent.loop;

import nomo.core.conversation.State;
import nomo.agent.conversation_events.{emit as emit_event, failure as fail_event, reject as reject_event};
import nomo.agent.stub_loop_controller.turn_controller;
import nomo.agent.console_events.publish as publish_console;
import nomo.model.conversation_output.ConversationOutput;
public import nomo.agent.conversation_events.Turn;

public flow emit(state: State, role: string, kind: string, name: string, text: string) -> State {
    return emit_event(state, role, kind, name, text) with {
        ConversationOutput.publish(event) => { resume publish_console(event); }
    };
}

public flow failure(state: State, message: string, status: i32) -> Turn {
    return fail_event(state, message, status) with {
        ConversationOutput.publish(event) => { resume publish_console(event); }
    };
}

public flow reject(state: State, message: string) -> Turn {
    return reject_event(state, message) with {
        ConversationOutput.publish(event) => { resume publish_console(event); }
    };
}

public flow turn(raw: string, maximum: i32, budget: i32, previous: State) -> Turn {
    return turn_controller(raw, maximum, budget, previous) with {
        ConversationOutput.publish(event) => { resume publish_console(event); }
    };
}
