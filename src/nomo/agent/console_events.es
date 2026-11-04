module nomo.agent.console_events;

import std.io.println;
import std.io.IOError as ConsoleError;
import nomo.core.conversation.Event;
import nomo.model.conversation_output.{ConsoleEventSink, ConversationSink};

public type PublicChildEvents = {};
public type RedactedChildEvents = {};
public type PublicHarnessEvents = {};
public type RedactedHarnessEvents = {};
flow harness(event: Event, text: string) -> unit ![Error<ConsoleError>] {
    println("EVENT " + event.role + " " + event.kind + " " + event.name + ": " + text);
}
impl PublicChildEvents ~ ConversationSink {
    flow publish(self, event: Event) -> unit ![Error<ConsoleError>] { publish(event); }
}
impl RedactedChildEvents ~ ConversationSink {
    flow publish(self, event: Event) -> unit ![Error<ConsoleError>] { println("CHILD EVENT " + event.role + " " + event.kind + " " + event.name + ": [REDACTED]"); }
}
impl PublicHarnessEvents ~ ConversationSink {
    flow publish(self, event: Event) -> unit ![Error<ConsoleError>] { harness(event, event.text); }
}
impl RedactedHarnessEvents ~ ConversationSink {
    flow publish(self, event: Event) -> unit ![Error<ConsoleError>] { harness(event, "[REDACTED]"); }
}

public flow publish(event: Event) -> unit ![Error<ConsoleError>] ~ ConsoleEventSink {
    let role = event.role; let kind = event.kind; let name = event.name; let text = event.text;
    if kind == "error" { println("error: " + text); }
    else if role == "model" { println(if kind == "text" { "model: text " + name } else { "model: tool " + name }); }
    else if role == "tool" { println("tool: " + name + ": " + text); }
    else { println(role + ": " + text); }
}
