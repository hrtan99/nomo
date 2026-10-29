module app.callable_negative;

import nomo.core.conversation.Event;
import nomo.model.conversation_output.ConsoleEventSink;

flow bad(event: Event) -> unit ![Error<string>] ~ ConsoleEventSink {
    perform Error<string>.raise("intentional outside-bound error");
}
public flow main(args: Array<string>) -> i32 {
    let event = Event { role = "user", kind = "input", name = "", text = "exact" };
    bad(event);
    return 0;
}
