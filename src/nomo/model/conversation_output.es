module nomo.model.conversation_output;

import std.io.IOError as ConsoleError;
import nomo.core.conversation.Event;

// Console is requested/default-handled by println; this bounds escaping errors.
public spec ConsoleEventSink: callable Event => unit ![Error<ConsoleError>];
public effect ConversationOutput { action publish(event: Event) -> unit; }
