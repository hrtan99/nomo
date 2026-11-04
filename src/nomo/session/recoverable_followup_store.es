module nomo.session.recoverable_followup_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, MemoryEntry, MemoryVersion,
    WriteCondition, WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.core.conversation.Event;
import nomo.session.redaction.Policy;
import nomo.session.recoverable_events.{Frame as EventFrame, empty as empty_events, work_batch};
import nomo.session.recoverable_chat_store.{Frame as ChatFrame, load as load_chat};
import nomo.session.history_work_guard.{Record, Budget};
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.recoverable_work_store.{Frame as ParentWork, load as load_parent_work, work_data_error, full, zero};
import nomo.session.recoverable_check_store.{Frame as ParentCheck, load as load_parent_check};
import nomo.session.edit_operation_store.inspect as inspect_parent_edit;

// One separately reserved followup slot linked to the current event-chat version.
// The work row and its bounded event batch commit together. Edit intent remains
// a separate durable boundary; if any boundary is uncertain, callers must
// retain the reservation and refuse replay rather than infer an outcome.
public type Frame = { format: i32, policy_binding: string, parent_work_version: string, parent_check_version: string, work: Record, events: EventFrame };
public type Ticket = { frame: Frame, version: MemoryVersion, chat: MemoryEntry<string, ChatFrame> };
alias Schema = MemoryRegion<{ Rows: Store<string, Frame> }>;
let Runs = std.memory.region<Schema>(stable_id = "nomo-recoverable-followup-v1", store = "recoverable-followup");


flow frame_error(value: Frame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding || value.parent_work_version == "" { return "invalid recoverable followup format or policy binding"; }
    return work_data_error(value.work, value.events, policy);
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> {
    // Validate the policy/binding against the actual chat frame first; a stale
    // or mismatched policy cannot make an existing work slot look absent.
    match load_chat(policy, binding) { Ok(Some(_)) => {} Ok(None()) => { return Err("recoverable chat missing"); } Err(error) => { return Err(error); } }
    let row = get_entry(Runs.Rows, "followup");
    match row {
        Some(item) => {
            if item.key != "followup" { return Err("recoverable followup key mismatch"); }
            let error = frame_error(item.value, policy, binding); if error != "" { return Err(error); }
            let parent_work = match load_parent_work(policy, binding) { Ok(Some(value)) => value, _ => { return Err("first work missing"); } };
            if (parent_work.value.work.phase != "complete" && parent_work.value.work.phase != "abandoned") || parent_work.version.opaque != item.value.parent_work_version || parent_work.value.work.id == item.value.work.id { return Err("first work changed"); }
            if parent_work.value.work.phase == "complete" {
            let parent_edit = match inspect_parent_edit(parent_work.value.work.id, parent_work.value.work.workspace, parent_work.value.work.path) { Ok(Some(value)) => value, _ => { return Err("first edit missing"); } };
            if parent_edit.phase != "completed" { return Err("first edit unresolved"); }
            }
            let parent_check = match load_parent_check(policy, binding) { Ok(value) => value, Err(error) => { return Err(error); } };
            let check_version = match parent_check { Some(value) => { if value.value.check.phase != "complete" && value.value.check.phase != "abandoned" && !(parent_work.value.work.phase == "abandoned" && value.value.check.phase == "planned") { return Err("first check unresolved"); } value.version.opaque }, None() => "" };
            if check_version != item.value.parent_check_version { return Err("first check changed"); }
        }
        None() => {}
    }
    return Ok(row);
}

flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = frame_error(value, policy, binding); if error != "" { return Err(error); }
    let before = match load(policy, binding) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if before != expected { return Err("recoverable followup changed; no retry"); }
    let condition: WriteCondition = match expected { Some(item) => Match(item.version), None() => Missing };
    let intent = prepare_put(Runs.Rows, "followup", value, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("recoverable followup commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("recoverable followup commit refused; no retry"); }
        WriteOutcome.Committed(item) => item,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "followup" || receipt.target.region != "nomo-recoverable-followup-v1" || receipt.target.store != ["Rows"] {
        return Err("recoverable followup receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite work receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("recoverable followup version missing"); } };
    let after = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable followup readback missing"); } };
    if after.value != value || after.version.opaque != version.opaque { return Err("recoverable followup readback mismatch; no retry"); }
    match expected { Some(item) => { if item.version.opaque == version.opaque { return Err("recoverable followup version did not change"); } } None() => {} }
    return Ok(version);
}

public flow admit(id: string, workspace: string, path: string, request: string, chat: MemoryEntry<string, ChatFrame>, policy: Policy, binding: string) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable chat missing or invalid"); } };
    if current != chat || chat.value.chat.invocation.admitted < 1 || chat.value.chat.phase == "running" || chat.value.chat.pending != "" {
        return Err("completed unchanged recoverable chat required");
    }
    match load(policy, binding) { Ok(None()) => {} Ok(Some(_)) => { return Err("recoverable followup already admitted; no retry"); } Err(error) => { return Err(error); } }
    let wide = chat.value.chat.format == 13;
    let row = Record { format = if wide { 4 } else { 5 }, phase = "running", id = id, workspace = workspace, path = path,
        request = request, history_version = chat.version.opaque, reserved = full(wide), settled = None(), summary = "" };
    let parent_work = match load_parent_work(policy, binding) { Ok(Some(item)) => item, _ => { return Err("completed first work required"); } };
    if (parent_work.value.work.phase != "complete" && parent_work.value.work.phase != "abandoned") || parent_work.value.work.id == id { return Err("completed distinct first work required"); }
    if parent_work.value.work.phase == "complete" {
    let first_edit = match inspect_parent_edit(parent_work.value.work.id, parent_work.value.work.workspace, parent_work.value.work.path) { Ok(Some(item)) => item, _ => { return Err("completed first edit required"); } };
    if first_edit.phase != "completed" { return Err("completed first edit required"); }
    }
    let parent_check = match load_parent_check(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let check_version = match parent_check { Some(item) => { if item.value.check.phase != "complete" && item.value.check.phase != "abandoned" && !(parent_work.value.work.phase == "abandoned" && item.value.check.phase == "planned") { return Err("first check unresolved"); } item.version.opaque }, None() => "" };
    let frame = Frame { format = 1, policy_binding = binding, parent_work_version = parent_work.version.opaque, parent_check_version = check_version, work = row, events = empty_events() };
    let version = match write(frame, None(), policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    return Ok(Ticket { frame = frame, version = version, chat = chat });
}

public flow claim(ticket: Ticket, policy: Policy, binding: string) -> Result<bool, string> {
    let current_chat = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable chat missing or invalid"); } };
    if current_chat != ticket.chat || ticket.frame.work.history_version != current_chat.version.opaque || ticket.frame.work.phase != "running" {
        return Err("recoverable followup chat binding changed; no retry");
    }
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable followup missing or invalid"); } };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque { return Err("recoverable followup reservation changed; no retry"); }
    return Ok(true);
}

public flow finish(ticket: Ticket, summary: string, spent: Ledger, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return Err(error); } }
    let events = match work_batch(records, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let old = ticket.frame.work;
    let row = Record { format = old.format, phase = "complete", id = old.id, workspace = old.workspace, path = old.path,
        request = old.request, history_version = old.history_version, reserved = zero(), settled = Some(spent), summary = summary };
    let frame = Frame { format = 1, policy_binding = binding, parent_work_version = ticket.frame.parent_work_version, parent_check_version = ticket.frame.parent_check_version, work = row, events = events };
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable followup missing or invalid"); } };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque { return Err("recoverable followup reservation changed; no retry"); }
    match write(frame, Some(current), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current = match load(policy, binding) { Ok(Some(value)) => value, _ => { return Err("interrupted followup missing"); } }; let old = current.value.work;
    if old.id != id || old.phase != "running" { return Err("interrupted followup identity or phase differs"); }
    let row = Record { format = old.format, phase = "abandoned", id = old.id, workspace = old.workspace, path = old.path, request = old.request, history_version = old.history_version, reserved = old.reserved, settled = old.settled, summary = old.summary };
    let frame = Frame { format = current.value.format, policy_binding = binding, parent_work_version = current.value.parent_work_version, parent_check_version = current.value.parent_check_version, work = row, events = current.value.events };
    return match write(frame, Some(current), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
