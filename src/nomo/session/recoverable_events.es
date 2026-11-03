module nomo.session.recoverable_events;

import std.collections.len as count;
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import nomo.core.conversation.Event;
import nomo.core.read_text.safe;
import nomo.session.redaction.{Policy, policy_error, text as redact};

// A pure, bounded projection. This does not persist events or grant authority.
// Exact known-literal filtering is not comprehensive secret detection; callers
// must supply an appropriate trusted policy before using any persisted form.
public type Frame = { format: i32, turns: i32, first_count: usize, events: Array<Event> };
public type Advance = { frame: Frame, replacements: usize };

public flow empty() -> Frame {
    return Frame { format = 1, turns = 0, first_count = 0, events = [] };
}

flow event_error(item: Event, policy: Policy) -> string {
    if !safe(item.role, 128) || !safe(item.kind, 128) || !safe(item.name, 128) || !safe(item.text, 8192) {
        return "invalid recoverable event content";
    }
    for field in [item.role, item.kind, item.name, item.text] limit Iterations(4) {
        let checked = match redact(field, policy) { Ok(value) => value, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "recoverable event contains a known sensitive literal"; }
    }
    return "";
}

public flow invalid(frame: Frame, policy: Policy) -> string {
    let policy_problem = policy_error(policy); if policy_problem != "" { return policy_problem; }
    let n = count(frame.events);
    if frame.format != 1 || frame.turns < 0 || frame.turns > 2 || n > 48 { return "invalid recoverable event frame"; }
    if frame.turns == 0 && (n != 0 || frame.first_count != 0) { return "invalid empty event frame"; }
    if frame.turns == 1 && (n == 0 || n > 24 || frame.first_count != n) { return "invalid first event boundary"; }
    if frame.turns == 2 && (frame.first_count == 0 || frame.first_count > 24 || frame.first_count >= n || n - frame.first_count > 24) {
        return "invalid second event boundary";
    }
    var bytes: usize = 0;
    for item in frame.events limit Iterations(48) {
        let error = event_error(item, policy); if error != "" { return error; }
        bytes = bytes + byte_count(utf8_encode(item.role)) + byte_count(utf8_encode(item.kind)) +
            byte_count(utf8_encode(item.name)) + byte_count(utf8_encode(item.text));
        if bytes > 65536 { return "recoverable event frame exceeds byte limit"; }
    }
    return "";
}

public flow append(before: Frame, turn: i32, input: Array<Event>, policy: Policy) -> Result<Advance, string> {
    let error = invalid(before, policy); if error != "" { return Err(error); }
    if turn != before.turns + 1 || turn > 2 || count(input) == 0 || count(input) > 24 { return Err("invalid recoverable event batch order or size"); }
    var records = before.events; var replacements: usize = 0;
    for item in input limit Iterations(24) {
        if !safe(item.role, 128) || !safe(item.kind, 128) || !safe(item.name, 128) { return Err("invalid event metadata"); }
        for field in [item.role, item.kind, item.name] limit Iterations(3) {
            let checked = match redact(field, policy) { Ok(value) => value, Err(problem) => { return Err(problem); } };
            if checked.replacements != 0 { return Err("sensitive literal in event metadata"); }
        }
        let clean = match redact(item.text, policy) { Ok(value) => value, Err(problem) => { return Err(problem); } };
        if !safe(clean.value, 8192) { return Err("recoverable event text exceeds limits or is unsafe"); }
        replacements = replacements + clean.replacements;
        records = records.push(Event { role = item.role, kind = item.kind, name = item.name, text = clean.value });
    }
    let first = if turn == 1 { count(records) } else { before.first_count };
    let next = Frame { format = 1, turns = turn, first_count = first, events = records };
    let problem = invalid(next, policy); if problem != "" { return Err(problem); }
    return Ok(Advance { frame = next, replacements = replacements });
}
