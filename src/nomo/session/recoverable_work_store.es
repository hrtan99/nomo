module nomo.session.recoverable_work_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, MemoryEntry, MemoryVersion,
    WriteCondition, WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.session.redaction.{Policy, text as redact};
import nomo.session.event_text_codec.{encode, decode};
import nomo.session.recoverable_events.{Frame as EventFrame, empty as empty_events, invalid as invalid_events, append};
import nomo.session.recoverable_chat_store.{Frame as ChatFrame, load as load_chat};
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

flow full() -> Budget { return Budget { steps = 13, calls = 7, generation = 51200, native_tokens = 196608 }; }
flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }

flow frame_error(value: Frame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding { return "invalid recoverable work format or policy binding"; }
    let work_error = invalid_work(value.work); if work_error != "" { return work_error; }
    let event_error = invalid_events(value.events, policy); if event_error != "" { return event_error; }
    if (value.work.phase == "running" && value.events.turns != 0) || (value.work.phase == "complete" && value.events.turns != 1) {
        return "work phase and event boundary differ";
    }
    for field in [value.work.id, value.work.workspace, value.work.path, value.work.request, value.work.summary] limit Iterations(5) {
        let checked = match redact(field, policy) { Ok(item) => item, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "work data contains a known sensitive literal"; }
    }
    for item in value.events.events limit Iterations(48) {
        match decode(item.text, policy) { Ok(_) => {} Err(error) => { return error; } }
    }
    return "";
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> {
    // Validate the policy/binding against the actual chat frame first; a stale
    // or mismatched policy cannot make an existing work slot look absent.
    match load_chat(policy, binding) { Ok(Some(_)) => {} Ok(None()) => { return Err("recoverable chat missing"); } Err(error) => { return Err(error); } }
    let row = get_entry(Runs.Rows, "work");
    match row {
        Some(item) => {
            if item.key != "work" { return Err("recoverable work key mismatch"); }
            let error = frame_error(item.value, policy, binding); if error != "" { return Err(error); }
        }
        None() => {}
    }
    return Ok(row);
}

flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = frame_error(value, policy, binding); if error != "" { return Err(error); }
    let before = match load(policy, binding) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if before != expected { return Err("recoverable work changed; no retry"); }
    let condition: WriteCondition = match expected { Some(item) => Match(item.version), None() => Missing };
    let intent = prepare_put(Runs.Rows, "work", value, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("recoverable work commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("recoverable work commit refused; no retry"); }
        WriteOutcome.Committed(item) => item,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "work" || receipt.target.region != "nomo-recoverable-work-v1" || receipt.target.store != ["Rows"] {
        return Err("recoverable work receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite work receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("recoverable work version missing"); } };
    let after = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable work readback missing"); } };
    if after.value != value || after.version.opaque != version.opaque { return Err("recoverable work readback mismatch; no retry"); }
    match expected { Some(item) => { if item.version.opaque == version.opaque { return Err("recoverable work version did not change"); } } None() => {} }
    return Ok(version);
}

public flow admit(id: string, workspace: string, path: string, request: string, chat: MemoryEntry<string, ChatFrame>, policy: Policy, binding: string) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable chat missing or invalid"); } };
    if current != chat || chat.value.chat.invocation.admitted < 1 || chat.value.chat.phase == "running" || chat.value.chat.pending != "" {
        return Err("completed unchanged recoverable chat required");
    }
    match load(policy, binding) { Ok(None()) => {} Ok(Some(_)) => { return Err("recoverable work already admitted; no retry"); } Err(error) => { return Err(error); } }
    let row = Record { format = 2, phase = "running", id = id, workspace = workspace, path = path,
        request = request, history_version = chat.version.opaque, reserved = full(), settled = None(), summary = "" };
    let frame = Frame { format = 1, policy_binding = binding, work = row, events = empty_events() };
    let version = match write(frame, None(), policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    return Ok(Ticket { frame = frame, version = version, chat = chat });
}

public flow claim(ticket: Ticket, policy: Policy, binding: string) -> Result<bool, string> {
    let current_chat = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable chat missing or invalid"); } };
    if current_chat != ticket.chat || ticket.frame.work.history_version != current_chat.version.opaque || ticket.frame.work.phase != "running" {
        return Err("recoverable work chat binding changed; no retry");
    }
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable work missing or invalid"); } };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque { return Err("recoverable work reservation changed; no retry"); }
    return Ok(true);
}

public flow finish(ticket: Ticket, summary: string, spent: Ledger, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return Err(error); } }
    if count(records) == 0 || count(records) > 24 { return Err("invalid work event batch"); }
    var encoded: Array<Event> = [];
    for item in records limit Iterations(24) {
        let text = match encode(item.text, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
        encoded = encoded.push(Event { role = item.role, kind = item.kind, name = item.name, text = text });
    }
    let events = match append(empty_events(), 1, encoded, policy) { Ok(item) => item.frame, Err(error) => { return Err(error); } };
    let old = ticket.frame.work;
    let row = Record { format = old.format, phase = "complete", id = old.id, workspace = old.workspace, path = old.path,
        request = old.request, history_version = old.history_version, reserved = zero(), settled = Some(spent), summary = summary };
    let frame = Frame { format = 1, policy_binding = binding, work = row, events = events };
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable work missing or invalid"); } };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque { return Err("recoverable work reservation changed; no retry"); }
    match write(frame, Some(current), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}
