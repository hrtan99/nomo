module nomo.agent.console_events;

import std.io.println;
import std.io.IOError as ConsoleError;
import nomo.core.conversation.Event;
import nomo.model.conversation_output.ConsoleEventSink;

public flow publish(event: Event) -> unit ![Error<ConsoleError>] ~ ConsoleEventSink {
    let role = event.role; let kind = event.kind; let name = event.name; let text = event.text;
    if kind == "error" { println("error: " + text); }
    else {
        if role == "model" {
            if kind == "text" { println("model: text " + name); }
            else { println("model: tool " + name); }
        }
        else {
            if role == "tool" { println("tool: " + name + ": " + text); }
            else { println(role + ": " + text); }
        }
    }
}
