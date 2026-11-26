module nomo.domain.sessions.store_record;

import std.collections.len as count;
import std.text.char_count as len;
import nomo.domain.text.text.printable;
import nomo.core.conversation.Event;
import nomo.session.session_state.Snapshot;
import nomo.domain.sessions.bundle_codec.Bundle;
import nomo.session.store_record.Record;

public flow valid_id(value: string) -> bool {
    if len(value) == 0 || len(value) > 128 { return false; }
    return printable(value);
}

public flow session_key(id: string, save_id: string) -> string {
    // Length prefixes make pairs unambiguous even when IDs contain delimiters.
    return "nomo-store-v1:" + std.text.from_usize(len(id)) + ":" + id + save_id;
}

public flow with_events(saved: Snapshot, events: Array<Event>) -> Snapshot {
    return saved { history = saved.history { events } };
}

public flow pending(saved: Snapshot, save_id: string) -> Record {
    var descriptors: Array<Event> = [];
    @limits([Iterations(32)]) for event in saved.history.events {
        descriptors = descriptors.push(event { text = "" });
    }
    return Record { format = 1, phase = "pending", save_id,
        session_key = session_key(saved.session_id, save_id), snapshot = with_events(saved, descriptors) };
}

public flow published(row: Record) -> Record {
    return row { phase = "published" };
}

public flow bundle(saved: Snapshot, save_id: string) -> Bundle {
    var bodies: Array<string> = [];
    @limits([Iterations(32)]) for event in saved.history.events { bodies = bodies.push(event.text); }
    return Bundle { format = 1, session_id = saved.session_id, save_id, bodies };
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
    @limits([Iterations(32)]) for descriptor in saved.history.events {
        if descriptor.text != "" { return Err("metadata contains duplicate event body"); }
        events = events.push(descriptor { text = body.bodies[index] });
        index = index + 1;
    }
    return Ok(with_events(saved, events));
}
