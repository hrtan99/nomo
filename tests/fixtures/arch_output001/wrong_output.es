module app.callable_negative;

import nomo.core.conversation.Event;
import nomo.application.harness.ports.model_conversation_output.ConsoleEventSink;

flow bad(event: Event) -> string ~ ConsoleEventSink { return event.text; }
public flow main(args: Array<string>) -> i32 {
    let event = Event { role = "user", kind = "input", name = "", text = "exact" };
    let value = bad(event);
    return 0;
}
