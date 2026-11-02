module app.event_history_probe;
import std.io.println;
import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.session.redaction.Policy;
import nomo.session.event_history.{append, load};

public flow event_history_probe(args: Array<string>) -> i32 ![Console, Memory, Error<IOError>, Error<StorageError>, Error<IndexError>] {
    if count(args) != 1 { abort("select test phase"); }
    let policy = Policy { format = 1, literals = ["VERY_SECRET_123", "ANOTHER_TOKEN_456"] };
    if args[0] == "first" {
        let events = [Event { role = "user", kind = "request", name = "", text = "ask VERY_SECRET_123" },
            Event { role = "tool", kind = "complete", name = "read", text = "complete: ANOTHER_TOKEN_456" }];
        match append(1, events, policy) { Ok(_) => {} Err(_) => { abort("first append failed"); } }
    } else if args[0] == "repeat" {
        let events = [Event { role = "user", kind = "request", name = "", text = "again" }];
        match append(1, events, policy) { Ok(_) => { abort("repeat accepted"); } Err(_) => {} }
    } else if args[0] == "second" {
        let events = [Event { role = "agent", kind = "answer", name = "", text = "result VERY_SECRET_123" }];
        match append(2, events, policy) { Ok(_) => {} Err(_) => { abort("second append failed"); } }
    } else if args[0] == "inspect" {
        let row = match load() { Ok(Some(value)) => value.value, _ => { abort("history missing"); } };
        if row.turns != 2 || count(row.events) != 3 || row.events[0].role != "user" || row.events[1].role != "tool" || row.events[2].role != "agent" ||
            row.events[0].text != "ask [REDACTED]" || row.events[1].text != "complete: [REDACTED]" || row.events[2].text != "result [REDACTED]" { abort("order or redaction mismatch"); }
    } else { abort("invalid test phase"); }
    println("PASS " + args[0]); return 0;
}
