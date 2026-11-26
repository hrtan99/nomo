module nomo.domain.sessions.recoverable_events;

import nomo.domain.text.read_text.{data_safe, safe};
import nomo.domain.context.large_context.{history_bytes, event_bytes};
import std.text.len as byte_len;
import nomo.core.conversation.Event;
import nomo.domain.sessions.redaction.{Policy, policy_error, text as redact};
import nomo.domain.sessions.event_text_codec.encode;
import nomo.session.recoverable_events.Frame;

public type Advance = { frame: Frame, replacements: usize };

public flow empty() -> Frame {
    return Frame { format = 1, turns = 0, first_count = 0, events = [] };
}

flow event_error(item: Event, policy: Policy) -> string {
    if !safe(item.role, 128) || !safe(item.kind, 128) || !safe(item.name, 128) || !data_safe(item.text, event_bytes()) {
        return "invalid recoverable event content";
    }
    @limits([Iterations(4)]) for field in [item.role, item.kind, item.name, item.text] {
        let checked = match redact(field, policy) { Ok(value) => value, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "recoverable event contains a known sensitive literal"; }
    }
    return "";
}

flow metadata_error(item: Event, policy: Policy) -> string {
    if !safe(item.role, 128) || !safe(item.kind, 128) || !safe(item.name, 128) { return "invalid event metadata"; }
    @limits([Iterations(3)]) for field in [item.role, item.kind, item.name] {
        let checked = match redact(field, policy) { Ok(value) => value, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "sensitive literal in event metadata"; }
    }
    return "";
}

// Structural validation for frames whose texts were produced by encode() in
// the current call. It deliberately avoids parsing and re-encoding every text;
// persisted frames still cross the full invalid()/decode() boundary on load.
public flow shape_error(frame: Frame, policy: Policy) -> string {
    let policy_problem = policy_error(policy); if policy_problem != "" { return policy_problem; }
    let n = frame.events.len();
    if (frame.format != 1 && frame.format != 2) || frame.turns < 0 || frame.turns > 48 || n > 4096 { return "invalid recoverable event frame"; }
    if frame.turns == 0 && (frame.first_count != 0 || (frame.format == 1 && n != 0)) { return "invalid empty event frame"; }
    if frame.turns == 1 && (frame.first_count == 0 || frame.first_count > (if frame.format == 2 { 768 } else { 24 }) || frame.first_count > n || (frame.format == 1 && frame.first_count != n)) { return "invalid first event boundary"; }
    if frame.turns >= 2 && (frame.first_count == 0 || frame.first_count > (if frame.format == 2 { 768 } else { 24 }) || frame.first_count >= n) {
        return "invalid later event boundary";
    }
    var bytes: usize = 0;
    @limits([Iterations(4096)]) for item in frame.events {
        let error = metadata_error(item, policy); if error != "" { return error; }
        if byte_len(item.text) > event_bytes() { return "recoverable event frame exceeds byte limit"; }
        bytes = bytes + byte_len(item.role) + byte_len(item.kind) + byte_len(item.name) + byte_len(item.text);
        if bytes > history_bytes() { return "recoverable event frame exceeds byte limit"; }
    }
    return "";
}

public flow invalid(frame: Frame, policy: Policy) -> string {
    let policy_problem = policy_error(policy); if policy_problem != "" { return policy_problem; }
    let n = frame.events.len();
    if (frame.format != 1 && frame.format != 2) || frame.turns < 0 || frame.turns > 48 || n > 4096 { return "invalid recoverable event frame"; }
    if frame.turns == 0 && (frame.first_count != 0 || (frame.format == 1 && n != 0)) { return "invalid empty event frame"; }
    if frame.turns == 1 && (frame.first_count == 0 || frame.first_count > (if frame.format == 2 { 768 } else { 24 }) || frame.first_count > n || (frame.format == 1 && frame.first_count != n)) { return "invalid first event boundary"; }
    if frame.turns >= 2 && (frame.first_count == 0 || frame.first_count > (if frame.format == 2 { 768 } else { 24 }) || frame.first_count >= n) {
        return "invalid later event boundary";
    }
    var bytes: usize = 0;
    @limits([Iterations(4096)]) for item in frame.events {
        let error = event_error(item, policy); if error != "" { return error; }
        bytes = bytes + byte_len(item.role) + byte_len(item.kind) + byte_len(item.name) + byte_len(item.text);
        if bytes > history_bytes() { return "recoverable event frame exceeds byte limit"; }
    }
    return "";
}

public flow append(before: Frame, turn: i32, input: Array<Event>, policy: Policy) -> Result<Advance, string> {
    let error = invalid(before, policy); if error != "" { return Err(error); }
    if turn != before.turns + 1 || turn > 48 || input.len() == 0 || input.len() > 24 { return Err("invalid recoverable event batch order or size"); }
    var records = before.events; var replacements: usize = 0;
    @limits([Iterations(24)]) for item in input {
        if !safe(item.role, 128) || !safe(item.kind, 128) || !safe(item.name, 128) { return Err("invalid event metadata"); }
        @limits([Iterations(3)]) for field in [item.role, item.kind, item.name] {
            let checked = match redact(field, policy) { Ok(value) => value, Err(problem) => { return Err(problem); } };
            if checked.replacements != 0 { return Err("sensitive literal in event metadata"); }
        }
        let clean = match redact(item.text, policy) { Ok(value) => value, Err(problem) => { return Err(problem); } };
        if !data_safe(clean.value, event_bytes()) { return Err("recoverable event text exceeds limits or is unsafe"); }
        replacements = replacements + clean.replacements;
        records = records.push(item { text = clean.value });
    }
    let first = if turn == 1 { records.len() } else { before.first_count };
    let next = before { turns = turn, first_count = first, events = records };
    let problem = invalid(next, policy); if problem != "" { return Err(problem); }
    return Ok(Advance { frame = next, replacements });
}

// Callers use this only with values returned by event_text_codec.encode in the
// same bounded operation. Avoid the otherwise quadratic MiB-scale cycle of
// safe/redact/JSON decode/encode before durable large-text externalization.
public flow append_encoded(before: Frame, turn: i32, input: Array<Event>, policy: Policy) -> Result<Advance, string> {
    let error = shape_error(before, policy); if error != "" { return Err(error); }
    if turn != before.turns + 1 || turn > 48 || input.len() == 0 || input.len() > 24 { return Err("invalid recoverable event batch order or size"); }
    var records = before.events;
    @limits([Iterations(24)]) for item in input {
        let problem = metadata_error(item, policy); if problem != "" { return Err(problem); }
        if byte_len(item.text) > event_bytes() { return Err("recoverable event text exceeds limits or is unsafe"); }
        records = records.push(item);
    }
    let first = if turn == 1 { records.len() } else { before.first_count };
    let next = before { turns = turn, first_count = first, events = records };
    let problem = shape_error(next, policy); if problem != "" { return Err(problem); }
    return Ok(Advance { frame = next, replacements = 0 });
}

// The first and followup work use the same bounded, redacted event batch.
public flow work_batch(records: Array<Event>, policy: Policy) -> Result<Frame, string> {
    if records.len() == 0 || records.len() > 24 { return Err("invalid work event batch"); }
    var encoded: Array<Event> = [];
    @limits([Iterations(24)]) for item in records {
        let text = match encode(item.text, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
        encoded = encoded.push(item { text });
    }
    return match append_encoded(empty(), 1, encoded, policy) { Ok(item) => Ok(item.frame), Err(error) => Err(error) };
}
