module nomo.session.store_record;

import std.collections.len as count;
import std.text.len;
import nomo.core.text.printable;
import nomo.core.conversation.{Event, State};
import nomo.session.session_state.Snapshot;
import nomo.session.bundle_codec.Bundle;

// Application metadata only: event bodies belong to the single Session bundle.
public type Record = { format: i32, phase: string, save_id: string, session_key: string, snapshot: Snapshot };

public flow valid_id(value: string) -> bool {
    if len(value) == 0 || len(value) > 128 { return false; }
    return printable(value);
}

public flow session_key(id: string, save_id: string) -> string {
    // Length prefixes make pairs unambiguous even when IDs contain delimiters.
    return "nomo-store-v1:" + std.text.to_string_usize(len(id)) + ":" + id + save_id;
}

public flow with_events(saved: Snapshot, events: Array<Event>) -> Snapshot {
    return Snapshot { format = saved.format, session_id = saved.session_id, generation = saved.generation,
        mode = saved.mode, binding = saved.binding, lifecycle = saved.lifecycle,
        history = State { events = events, characters = saved.history.characters, spent = saved.history.spent, stopped = saved.history.stopped },
        references = saved.references, operations = saved.operations, original_caps = saved.original_caps,
        current_caps = saved.current_caps, ledger = saved.ledger };
}

public flow pending(saved: Snapshot, save_id: string) -> Record {
    var descriptors: Array<Event> = [];
    for event in saved.history.events limit Iterations(32) {
        descriptors = descriptors.push(Event { role = event.role, kind = event.kind, name = event.name, text = "" });
    }
    return Record { format = 1, phase = "pending", save_id = save_id,
        session_key = session_key(saved.session_id, save_id), snapshot = with_events(saved, descriptors) };
}

public flow published(row: Record) -> Record {
    return Record { format = row.format, phase = "published", save_id = row.save_id, session_key = row.session_key, snapshot = row.snapshot };
}

public flow bundle(saved: Snapshot, save_id: string) -> Bundle {
    var bodies: Array<string> = [];
    for event in saved.history.events limit Iterations(32) { bodies = bodies.push(event.text); }
    return Bundle { format = 1, session_id = saved.session_id, save_id = save_id, bodies = bodies };
}

public flow restore(row: Record, body: Bundle) -> Result<Snapshot, string> {
    if row.format != 1 || (row.phase != "pending" && row.phase != "published") { return Err("invalid metadata format or phase"); }
    if !valid_id(row.save_id) || !valid_id(row.snapshot.session_id) { return Err("invalid metadata identity"); }
    if row.session_key != session_key(row.snapshot.session_id, row.save_id) || body.format != 1 ||
        body.session_id != row.snapshot.session_id || body.save_id != row.save_id { return Err("bundle identity mismatch"); }
    let saved = row.snapshot;
    if count(body.bodies) > 32 || count(saved.history.events) != count(body.bodies) ||
        count(saved.references) != count(body.bodies) || count(saved.operations) > 32 { return Err("bundle descriptor count mismatch"); }
    var events: Array<Event> = [];
    var index: usize = 0;
    for descriptor in saved.history.events limit Iterations(32) {
        if descriptor.text != "" { return Err("metadata contains duplicate event body"); }
        events = events.push(Event { role = descriptor.role, kind = descriptor.kind, name = descriptor.name, text = body.bodies[index] });
        index = index + 1;
    }
    return Ok(with_events(saved, events));
}
