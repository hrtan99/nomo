module nomo.application.harness.ports.model_conversation_output;

import std.io.IOError as ConsoleError;
import nomo.core.conversation.Event;

// Console is requested/default-handled by println; this bounds escaping errors.
public spec ConsoleEventSink: callable Event => unit ![Error<ConsoleError>];

public spec ConversationSink {
    flow publish(self, event: Event) -> unit ![Error<ConsoleError>];
}
