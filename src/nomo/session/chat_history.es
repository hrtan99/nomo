module nomo.session.chat_history;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.session.chat_session_contract.{Session, invalid, fresh, begin, complete};
import nomo.harness.harness_tool_chat_contract.{Completed, TurnResult};
import nomo.session.event_history.{load as load_events, append_metadata};

// Versions 1 and 2 are retained for existing sessions. Version 3 atomically stores
// the same chat checkpoint together with bounded redacted event metadata.
public type Frame = { format: i32, chat: Session, first_count: usize, events: Array<Event> };
public type Entry = { key: string, value: Session, version: MemoryVersion, first_count: usize, events: Array<Event>, schema: i32, pending: bool };
alias LegacySchema = MemoryRegion<{ Rows: Store<string, Session> }>;
alias FrameSchema = MemoryRegion<{ Rows: Store<string, Frame> }>;
let Legacy = std.memory.region<LegacySchema>(stable_id = "nomo-chat-history-v1", store = "chat-history");
let Frames = std.memory.region<FrameSchema>(stable_id = "nomo-chat-history-v3", store = "chat-history-v3");
flow legacy() -> Option<MemoryEntry<string, Session>> { return get_entry(Legacy.Rows, "latest"); }
flow framed() -> Option<MemoryEntry<string, Frame>> { return get_entry(Frames.Rows, "latest"); }
flow safe_role(value: string) -> bool { return value == "user" || value == "main" || value == "tool" || value == "model" || value == "assistant" || value == "error" || value == "other"; }
flow safe_kind(value: string) -> bool { return value == "request" || value == "plan" || value == "delegate" || value == "context" || value == "input" || value == "tool" || value == "result" || value == "consume" || value == "answer" || value == "final" || value == "error" || value == "event"; }
flow safe_name(value: string) -> bool { return value == "" || value == "child-1" || value == "read" || value == "search"; }
flow frame_error(frame: Frame) -> string {
    if frame.format != 3 || (frame.chat.format != 3 && frame.chat.format != 6) { return "invalid chat frame format"; }
    let error = invalid(frame.chat); if error != "" { return error; }
    let n = count(frame.events); let turns = frame.chat.invocation.admitted;
    if n > 48 || (turns == 0 && (n != 0 || frame.first_count != 0)) ||
        (turns == 1 && (n == 0 || frame.first_count != n)) ||
        (turns == 2 && (frame.first_count == 0 || frame.first_count >= n)) { return "invalid chat event boundaries"; }
    for event in frame.events limit Iterations(48) {
        if !safe_role(event.role) || !safe_kind(event.kind) || !safe_name(event.name) || event.text != "[REDACTED]" { return "invalid redacted chat event"; }
    }
    return "";
}
public flow load() -> Result<Option<Entry>, string> {
    let old = legacy(); let new = framed();
    if old != None() && new != None() { return Err("multiple chat history formats"); }
    match old {
        Some(item) => {
            if item.key != "latest" || (item.value.format != 1 && item.value.format != 2) { return Err("invalid legacy history"); }
            let error = invalid(item.value); if error != "" { return Err(error); }
            let timeline = match load_events() { Ok(value) => value, Err(problem) => { return Err(problem); } };
            var events: Array<Event> = []; var first_count: usize = 0; var pending = false;
            match timeline {
                Some(value) => {
                    if item.value.format != 2 { return Err("unexpected events for legacy history"); }
                    let turns = value.value.turns; let admitted = item.value.invocation.admitted;
                    if turns != admitted {
                        if item.value.phase != "running" || turns != admitted + 1 { return Err("legacy event history differs from chat"); }
                        pending = true;
                    }
                    events = value.value.events; first_count = value.value.first_count;
                }
                None() => { if item.value.format == 2 && item.value.invocation.admitted > 0 { return Err("legacy event history missing"); } }
            }
            return Ok(Some(Entry { key = item.key, value = item.value, version = item.version, first_count = first_count, events = events, schema = item.value.format, pending = pending }));
        }
        None() => {}
    }
    match new {
        Some(item) => {
            if item.key != "latest" { return Err("chat history key mismatch"); }
            match load_events() { Ok(None()) => {} Ok(Some(_)) => { return Err("unexpected separate event history"); } Err(error) => { return Err(error); } }
            let error = frame_error(item.value); if error != "" { return Err(error); }
            return Ok(Some(Entry { key = item.key, value = item.value.chat, version = item.version,
                first_count = item.value.first_count, events = item.value.events, schema = 3, pending = false }));
        }
        None() => {
            match load_events() { Ok(None()) => {} Ok(Some(_)) => { return Err("orphan event history"); } Err(error) => { return Err(error); } }
            return Ok(None());
        }
    }
}
flow transition(before: Option<Entry>, next: Session) -> string {
    let prior = match before {
        None() => { if next != fresh() { return "chat session must start fresh"; } return ""; }
        Some(item) => item.value,
    };
    if prior.phase == "ready" {
        let reserved = match begin(prior, next.pending) { Ok(item) => item, Err(error) => { return error; } };
        if reserved != next { return "chat session reservation changed"; }
        return "";
    }
    if prior.phase != "running" { return "completed session cannot transition"; }
    let selected = next.invocation.prior;
    let done = Completed { request = prior.pending, task = selected.task, result = selected.result, tool = selected.tool,
        outcome = selected.outcome, answer = selected.answer, records = [] };
    let outcome = TurnResult { status = 0, state = next.invocation, resolved = true, completed = Some(done) };
    let finished = match complete(prior, outcome) { Ok(item) => item, Err(error) => { return error; } };
    if finished != next { return "chat session completion changed"; }
    return "";
}
flow project(input: Array<Event>) -> Result<Array<Event>, string> {
    if count(input) == 0 || count(input) > 24 { return Err("invalid completed event batch"); }
    var output: Array<Event> = [];
    for item in input limit Iterations(24) {
        let role = if safe_role(item.role) { item.role } else { "other" };
        let kind = if safe_kind(item.kind) { item.kind } else { "event" };
        let name = if safe_name(item.name) { item.name } else { "" };
        output = output.push(Event { role = role, kind = kind, name = name, text = "[REDACTED]" });
    }
    return Ok(output);
}
flow save_inner(value: Session, expected: Option<Entry>, records: Array<Event>) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(value); if error != "" { return Err(error); }
    let before = match load() { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if before != expected { return Err("chat history changed before save; no retry"); }
    let change = transition(before, value); if change != "" { return Err(change); }
    let condition: WriteCondition = match before { Some(entry) => Match(entry.version), None() => Missing };
    let schema = match before { Some(entry) => entry.schema, None() => 3 };
    if schema == 1 || schema == 2 {
        if value.format != schema { return Err("legacy history format changed"); }
        let previous_turns = match before { Some(item) => item.value.invocation.admitted, None() => 0 };
        if schema == 2 && value.invocation.admitted == previous_turns + 1 {
            match append_metadata(value.invocation.admitted, records) { Ok(_) => {} Err(problem) => { return Err(problem); } }
        }
        let intent = prepare_put(Legacy.Rows, "latest", value, condition); let operation = operation_ref(intent);
        let receipt = match commit(intent) { WriteOutcome.Unknown(_) => { return Err("chat history commit unknown; no retry"); } WriteOutcome.NotCommitted(_, _) => { return Err("chat history commit refused; no retry"); } WriteOutcome.Committed(item) => item };
        if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != "latest" || receipt.target.region != "nomo-chat-history-v1" || receipt.target.store != ["Rows"] { return Err("legacy history receipt mismatch"); }
        let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false }; if !durable { return Err("durable SQLite chat receipt required"); }
        let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("history version required"); } };
        let after = match load() { Ok(Some(item)) => item, _ => { return Err("history readback missing"); } };
        if after.value != value || after.version.opaque != version.opaque || after.schema != schema || after.pending { return Err("legacy readback mismatch"); }
        match before { Some(old) => { if old.version.opaque == version.opaque { return Err("history version did not change"); } } None() => {} }
        return Ok(version);
    }
    var events: Array<Event> = []; var first_count: usize = 0; var previous_turns: i32 = 0;
    match before { Some(item) => { events = item.events; first_count = item.first_count; previous_turns = item.value.invocation.admitted; } None() => {} }
    if value.invocation.admitted == previous_turns + 1 {
        let batch = match project(records) { Ok(item) => item, Err(problem) => { return Err(problem); } };
        if previous_turns == 0 { first_count = count(batch); }
        for item in batch limit Iterations(24) { events = events.push(item); }
    } else if count(records) != 0 { return Err("unexpected completed event batch"); }
    let frame = Frame { format = 3, chat = value, first_count = first_count, events = events };
    let problem = frame_error(frame); if problem != "" { return Err(problem); }
    let intent = prepare_put(Frames.Rows, "latest", frame, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) { WriteOutcome.Unknown(_) => { return Err("chat frame commit unknown; no retry"); } WriteOutcome.NotCommitted(_, _) => { return Err("chat frame commit refused; no retry"); } WriteOutcome.Committed(item) => item };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != "latest" || receipt.target.region != "nomo-chat-history-v3" || receipt.target.store != ["Rows"] { return Err("chat frame receipt mismatch"); }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false }; if !durable { return Err("durable SQLite chat frame required"); }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("chat frame version required"); } };
    let after = match load() { Ok(Some(item)) => item, _ => { return Err("chat frame readback missing"); } };
    if after.value != value || after.events != events || after.first_count != first_count || after.version.opaque != version.opaque || after.schema != 3 { return Err("chat frame readback mismatch"); }
    match before { Some(old) => { if old.version.opaque == version.opaque { return Err("chat frame version did not change"); } } None() => {} }
    return Ok(version);
}
public flow save(value: Session, expected: Option<Entry>) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] { return save_inner(value, expected, []); }
public flow save_completed(value: Session, expected: Option<Entry>, records: Array<Event>) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] { return save_inner(value, expected, records); }
