module app.recoverable_events_probe;

import std.io.println;
import nomo.core.conversation.Event;
import nomo.session.redaction.Policy;
import nomo.session.recoverable_events.{Frame, empty, invalid, append};

public flow recoverable_events_probe(args: Array<string>) -> i32 {
    if args != [] { abort("unexpected args"); }
    let policy = Policy { format = 1, literals = ["VERY_SECRET_123"] };
    let first = [Event { role = "user", kind = "request", name = "", text = "Read the configuration" },
        Event { role = "tool", kind = "result", name = "read", text = "complete: port=4321 VERY_SECRET_123" },
        Event { role = "assistant", kind = "final", name = "", text = "The port is 4321" }];
    let one = match append(empty(), 1, first, policy) { Ok(value) => value, Err(_) => { abort("first batch refused"); } };
    if one.replacements != 1 || one.frame.first_count != 3 || one.frame.events[1].text != "complete: port=4321 [REDACTED]" {
        abort("first batch not preserved and filtered");
    }
    let second = [Event { role = "user", kind = "request", name = "", text = "Check that result" },
        Event { role = "tool", kind = "result", name = "check", text = "exit=0 CHECK_OK" }];
    let two = match append(one.frame, 2, second, policy) { Ok(value) => value, Err(_) => { abort("second batch refused"); } };
    if two.replacements != 0 || two.frame.turns != 2 || two.frame.first_count != 3 ||
        two.frame.events[0] != one.frame.events[0] || two.frame.events[1] != one.frame.events[1] ||
        two.frame.events[3].text != "Check that result" || two.frame.events[4].text != "exit=0 CHECK_OK" || invalid(two.frame, policy) != "" {
        abort("event order or tool results changed");
    }
    match append(one.frame, 1, second, policy) { Ok(_) => { abort("reordered batch accepted"); } Err(_) => {} }
    let three = match append(two.frame, 3, second, policy) { Ok(value) => value, Err(_) => { abort("third batch refused"); } };
    if three.frame.turns != 3 || three.frame.events[5].text != "Check that result" { abort("third batch lost"); }
    let changed = Policy { format = 1, literals = ["port=4321"] };
    if invalid(one.frame, changed) == "" { abort("newly sensitive existing data accepted"); }
    let unsafe_event = [Event { role = "tool", kind = "result", name = "read", text = "line\nbreak" }];
    match append(empty(), 1, unsafe_event, policy) { Ok(_) => { abort("unsafe event accepted"); } Err(_) => {} }
    let metadata = [Event { role = "VERY_SECRET_123", kind = "result", name = "", text = "ok" }];
    match append(empty(), 1, metadata, policy) { Ok(_) => { abort("sensitive metadata accepted"); } Err(_) => {} }
    var long = ""; var i: usize = 0;
    while i < 8193 limit Iterations(8193) { long = long + "a"; i = i + 1; }
    match append(empty(), 1, [Event { role = "tool", kind = "result", name = "read", text = long }], policy) {
        Ok(_) => { abort("oversized text accepted"); } Err(_) => {}
    }
    var many: Array<Event> = []; var j: usize = 0;
    while j < 25 limit Iterations(25) { many = many.push(Event { role = "tool", kind = "result", name = "read", text = "ok" }); j = j + 1; }
    match append(empty(), 1, many, policy) { Ok(_) => { abort("oversized batch accepted"); } Err(_) => {} }
    println("PASS recoverable event projection: ordered; complete bounded tool result; known literal filtered; invalid order and unsafe data refused");
    return 0;
}
