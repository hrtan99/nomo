module nomo.session.recoverable_work_store;

import nomo.session.cas_rows.{Target, commit_native};
import std.memory.{get_entry, MemoryEntry, MemoryVersion, WriteCondition, Missing, Match};
import nomo.core.conversation.Event;
import nomo.session.redaction.{Policy, text as redact};
import nomo.session.event_text_codec.decode;
import nomo.session.recoverable_events.{Frame as EventFrame, empty as empty_events, invalid as invalid_events, work_batch};
import nomo.session.recoverable_chat_store.{Frame as ChatFrame, matches_version as chat_matches_version};
import nomo.session.history_work_guard.{Record, Budget, invalid as invalid_work};
import nomo.harness.harness_work_contract.Ledger;

// One separately reserved work slot linked to the current event-chat version.
// The work row and its bounded event batch commit together. Edit intent remains
// a separate durable boundary; if any boundary is uncertain, callers must
// retain the reservation and refuse replay rather than infer an outcome.
public type Frame = { format: i32, policy_binding: string, work: Record, events: EventFrame };
public type Ticket = { frame: Frame, version: MemoryVersion, chat: MemoryEntry<string, ChatFrame> };
alias Schema = MemoryRegion<{ Rows: Store<string, Frame> }>;
let Runs = std.memory.region<Schema>(stable_id = "nomo-recoverable-work-v1", store = "recoverable-work");

public flow full(wide: bool) -> Budget { return Budget { steps = 13, calls = 7, generation = if wide { 286720 } else { 51200 }, native_tokens = if wide { 2811008 } else { 1335296 } }; }
public flow full_mode(wide: bool, high_input: bool) -> Budget { return if high_input { Budget { steps = 13, calls = 7, generation = 188416, native_tokens = 6000000 } } else { full(wide) }; }
public flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }

public flow running_record(id: string, workspace: string, path: string, request: string, history_version: string, wide: bool) -> Record {
    return Record { format = if wide { 8 } else { 5 }, phase = "running", id = id, workspace = workspace, path = path,
        request = request, history_version = history_version, reserved = full(wide), settled = None(), summary = "" };
}
public flow running_record_mode(id: string, workspace: string, path: string, request: string, history_version: string, wide: bool, high_input: bool) -> Record {
    return Record { format = if high_input { 9 } else { if wide { 8 } else { 5 } }, phase = "running", id = id, workspace = workspace, path = path,
        request = request, history_version = history_version, reserved = full_mode(wide, high_input), settled = None(), summary = "" };
}
public flow completed_record(old: Record, summary: string, spent: Ledger) -> Record {
    return Record { format = old.format, phase = "complete", id = old.id, workspace = old.workspace, path = old.path,
        request = old.request, history_version = old.history_version, reserved = zero(), settled = Some(spent), summary = summary };
}
public flow abandoned_record(old: Record, id: string, label: string) -> Result<Record, string> {
    if old.id != id || old.phase != "running" { return Err("interrupted " + label + " identity or phase differs"); }
    return Ok(Record { format = old.format, phase = "abandoned", id = old.id, workspace = old.workspace, path = old.path,
        request = old.request, history_version = old.history_version, reserved = old.reserved, settled = old.settled, summary = old.summary });
}
public flow admission_chat_error(current: MemoryEntry<string, ChatFrame>, expected: MemoryEntry<string, ChatFrame>) -> string {
    if current != expected || expected.value.chat.invocation.admitted < 1 || expected.value.chat.phase == "running" || expected.value.chat.pending != "" { return "completed unchanged recoverable chat required"; }
    return "";
}
public flow claim_chat_error(current: MemoryEntry<string, ChatFrame>, expected: MemoryEntry<string, ChatFrame>, work: Record, label: string) -> string {
    if current != expected || work.history_version != current.version.opaque || work.phase != "running" { return label + " chat binding changed; no retry"; }
    return "";
}

public flow work_data_error(work: Record, events: EventFrame, policy: Policy) -> string {
    let work_error = invalid_work(work); if work_error != "" { return work_error; }
    let event_error = invalid_events(events, policy); if event_error != "" { return event_error; }
    if ((work.phase == "running" || work.phase == "abandoned") && events.turns != 0) || (work.phase == "complete" && events.turns != 1) {
        return "work phase and event boundary differ";
    }
    for field in [work.id, work.workspace, work.path, work.request, work.summary] limit Iterations(5) {
        let checked = match redact(field, policy) { Ok(item) => item, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "work data contains a known sensitive literal"; }
    }
    for item in events.events limit Iterations(48) {
        match decode(item.text, policy) { Ok(_) => {} Err(error) => { return error; } }
    }
    return "";
}

flow frame_error(value: Frame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding { return "invalid recoverable work format or policy binding"; }
    return work_data_error(value.work, value.events, policy);
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = get_entry(Runs.Rows, "work");
    return match row {
        Some(item) => {
            if item.key != "work" { return Err("recoverable work key mismatch"); }
            let error = frame_error(item.value, policy, binding); if error != "" { return Err(error); }
            Ok(Some(item))
        }
        None() => Ok(None())
    };
}
flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryEntry<string, Frame>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let desired = Frame { format = 1, policy_binding = value.policy_binding, work = value.work, events = value.events };
    let error = frame_error(desired, policy, binding); if error != "" { return Err(error); }
    let condition: WriteCondition = match expected { Some(item) => Match(item.version), None() => Missing };
    let target = Target { store = ["Rows"], region = "nomo-recoverable-work-v1", key = "work", label = "recoverable work" };
    let version = match commit_native(Runs.Rows, target, desired, condition) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    // commit_native already verifies the exact stored value and version. Keep
    // the value already owned by this process instead of loading it again.
    match expected { Some(item) => { if item.version.opaque == version.opaque { return Err("recoverable work version did not change"); } } None() => {} }
    return Ok(MemoryEntry { key = "work", value = desired, version = version });
}

public flow admit(id: string, workspace: string, path: string, request: string, chat: MemoryEntry<string, ChatFrame>, policy: Policy, binding: string) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let chat_error = admission_chat_error(chat, chat); if chat_error != "" { return Err(chat_error); }
    let current = match chat_matches_version(chat.version) { Ok(item) => item, Err(error) => { return Err(error); } };
    if !current { return Err("completed recoverable chat changed; no retry"); }
    match load(policy, binding) { Ok(None()) => {} Ok(Some(_)) => { return Err("recoverable work already admitted; no retry"); } Err(error) => { return Err(error); } }
    let wide = chat.value.chat.format >= 13;
    let row = running_record_mode(id, workspace, path, request, chat.version.opaque, wide, chat.value.chat.format == 18);
    let frame = Frame { format = 1, policy_binding = binding, work = row, events = empty_events() };
    let saved = match write(frame, None(), policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    return Ok(Ticket { frame = frame, version = saved.version, chat = chat });
}

flow claimed(ticket: Ticket, policy: Policy, binding: string) -> Result<MemoryEntry<string, Frame>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if ticket.frame.work.history_version != ticket.chat.version.opaque || ticket.frame.work.phase != "running" { return Err("recoverable work chat binding changed; no retry"); }
    let current_chat = match chat_matches_version(ticket.chat.version) { Ok(item) => item, Err(error) => { return Err(error); } };
    if !current_chat { return Err("recoverable work chat binding changed; no retry"); }
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable work missing or invalid"); } };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque { return Err("recoverable work reservation changed; no retry"); }
    return Ok(current);
}

public flow claim(ticket: Ticket, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return match claimed(ticket, policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

public flow finish(ticket: Ticket, summary: string, spent: Ledger, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current = match claimed(ticket, policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let events = match work_batch(records, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let row = completed_record(ticket.frame.work, summary, spent);
    let frame = Frame { format = 1, policy_binding = binding, work = row, events = events };
    match write(frame, Some(current), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

// Only the owner which observed successful cleanup may call this decision flow.
public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current = match load(policy, binding) { Ok(Some(value)) => value, _ => { return Err("interrupted work missing"); } };
    let row = match abandoned_record(current.value.work, id, "work") { Ok(value) => value, Err(error) => { return Err(error); } };
    let frame = Frame { format = current.value.format, policy_binding = binding, work = row, events = current.value.events };
    return match write(frame, Some(current), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
