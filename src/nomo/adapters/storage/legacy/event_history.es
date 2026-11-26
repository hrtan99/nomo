module nomo.adapters.storage.legacy.event_history;

import nomo.domain.text.read_text.{data_safe, safe};
import nomo.domain.context.large_context.event_bytes;
import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_receipt;
import std.memory.{MemoryVersion, MemoryEntry, Missing};
import std.memory.WriteCondition;
import nomo.core.conversation.Event;
import nomo.domain.sessions.redaction.{Policy, events as redact_events};
import nomo.session.event_history.{History, EventStore};

flow read_raw() -> Option<MemoryEntry<string, History>> { return EventStore.Rows.get_entry("events"); }

flow invalid(value: History) -> string {
    if value.format != 1 || value.turns < 1 || value.turns > 2 || value.events.len() < 1 || value.events.len() > 48 {
        return "invalid event history bounds";
    }
    if value.first_count < 1 || value.first_count > value.events.len() ||
        (value.turns == 1 && value.first_count != value.events.len()) ||
        (value.turns == 2 && value.first_count == value.events.len()) { return "invalid event turn boundary"; }
    @limits([Iterations(48)]) for event in value.events {
        if !safe(event.role, 128) || !safe(event.kind, 128) || !safe(event.name, 128) || !data_safe(event.text, event_bytes()) {
            return "invalid event history content";
        }
    }
    return "";
}

public flow load() -> Result<Option<MemoryEntry<string, History>>, string> {
    let entry = read_raw();
    match entry {
        Some(value) => {
            if value.key != "events" { return Err("event history key mismatch"); }
            let error = invalid(value.value); if error != "" { return Err(error); }
        }
        None() => (),
    }
    return Ok(entry);
}

public flow append(turn: i32, input: Array<Event>, policy: Policy) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let clean = match redact_events(input, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    if clean.events.len() == 0 { return Err("empty event batch"); }
    let before = match load() { Ok(value) => value, Err(error) => { return Err(error); } };
    var prior: Array<Event> = [];
    let previous_turn = match before { Some(entry) => { prior = entry.value.events; entry.value.turns } None() => 0 };
    let first_count = match before { Some(entry) => entry.value.first_count, None() => clean.events.len() };
    if turn != previous_turn + 1 || turn > 2 { return Err("event batch order differs; no retry"); }
    @limits([Iterations(24)]) for item in clean.events { prior = prior.push(item); }
    let next = History { format = 1, turns = turn, first_count, events = prior };
    let error = invalid(next); if error != "" { return Err(error); }
    let condition: WriteCondition = match before { Some(entry) => WriteCondition.Match(entry.version), None() => Missing };
    let version = match commit_receipt(EventStore.Rows, Target { store = ["Rows"], region = "nomo-event-history-v1", key = "events", label = "event history" }, next, condition) { Ok(item) => item, Err(error) => { return Err(error); } };
    let after = match load() { Ok(Some(value)) => value, _ => { return Err("event history readback missing or invalid"); } };
    if after.value != next || after.version.opaque != version.opaque { return Err("event history readback mismatch; no retry"); }
    match before { Some(value) => { if value.version.opaque == version.opaque { return Err("event history version did not change"); } }, None() => (), }
    return Ok(version);
}

// A conservative product projection: all free text and unrecognized metadata
// are removed. This preserves event ordering, not full tool-result content.
public flow append_metadata(turn: i32, input: Array<Event>) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if input.len() < 1 || input.len() > 24 { return Err("event batch exceeds bounds"); }
    var clean: Array<Event> = [];
    @limits([Iterations(24)]) for item in input {
        let role = if item.role == "user" || item.role == "main" || item.role == "tool" || item.role == "model" || item.role == "assistant" || item.role == "error" { item.role } else { "other" };
        let kind = if item.kind == "request" || item.kind == "plan" || item.kind == "delegate" || item.kind == "context" || item.kind == "input" || item.kind == "tool" || item.kind == "result" || item.kind == "consume" || item.kind == "answer" || item.kind == "final" || item.kind == "error" { item.kind } else { "event" };
        let name = if item.name == "child-1" || item.name == "read" || item.name == "search" { item.name } else { "" };
        clean = clean.push(Event { role, kind, name, text = "[REDACTED]" });
    }
    return append(turn, clean, Policy { format = 1, literals = ["NOMO_REDACTION_SENTINEL"] });
}
