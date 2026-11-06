module nomo.session.recoverable_followup_store;

import nomo.session.cas_rows.{Target, commit_native};
import std.memory.{get_entry, MemoryEntry, MemoryVersion, WriteCondition, Missing, Match};
import nomo.core.conversation.Event;
import nomo.session.redaction.Policy;
import nomo.session.recoverable_events.{Frame as EventFrame, empty as empty_events, work_batch};
import nomo.session.recoverable_chat_store.{Frame as ChatFrame, load as load_chat};
import nomo.session.history_work_guard.{Record};
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.recoverable_work_store.{load as load_parent_work, work_data_error, running_record_mode, completed_record, abandoned_record, admission_chat_error, claim_chat_error};
import nomo.session.recoverable_check_store.{ load as load_parent_check};
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

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    // Validate the policy/binding against the actual chat frame first; a stale
    // or mismatched policy cannot make an existing work slot look absent.
    match load_chat(policy, binding) { Ok(Some(_)) => {} Ok(None()) => { return Err("recoverable chat missing"); } Err(error) => { return Err(error); } }
    let row = get_entry(Runs.Rows, "followup");
    return match row {
        Some(item) => {
            if item.key != "followup" { return Err("recoverable followup key mismatch"); }
            let value = item.value;
            let error = frame_error(value, policy, binding); if error != "" { return Err(error); }
            let parent_work = match load_parent_work(policy, binding) { Ok(Some(value)) => value, _ => { return Err("first work missing"); } };
            if (parent_work.value.work.phase != "complete" && parent_work.value.work.phase != "abandoned") || parent_work.version.opaque != value.parent_work_version || parent_work.value.work.id == value.work.id { return Err("first work changed"); }
            if parent_work.value.work.phase == "complete" {
            let parent_edit = match inspect_parent_edit(parent_work.value.work.id, parent_work.value.work.workspace, parent_work.value.work.path) { Ok(Some(value)) => value, _ => { return Err("first edit missing"); } };
            if parent_edit.phase != "completed" { return Err("first edit unresolved"); }
            }
            let parent_check = match load_parent_check(policy, binding) { Ok(value) => value, Err(error) => { return Err(error); } };
            let check_version = match parent_check { Some(value) => { if value.value.check.phase != "complete" && value.value.check.phase != "abandoned" && !(parent_work.value.work.phase == "abandoned" && value.value.check.phase == "planned") { return Err("first check unresolved"); } value.version.opaque }, None() => "" };
            if check_version != value.parent_check_version { return Err("first check changed"); }
            Ok(Some(item))
        }
        None() => Ok(None())
    };
}
flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let desired = Frame { format = 1, policy_binding = value.policy_binding, parent_work_version = value.parent_work_version,
        parent_check_version = value.parent_check_version, work = value.work, events = value.events };
    let error = frame_error(desired, policy, binding); if error != "" { return Err(error); }
    let before = match load(policy, binding) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if before != expected { return Err("recoverable followup changed; no retry"); }
    let condition: WriteCondition = match expected { Some(item) => Match(item.version), None() => Missing };
    let target = Target { store = ["Rows"], region = "nomo-recoverable-followup-v1", key = "followup", label = "recoverable followup" };
    let version = match commit_native(Runs.Rows, target, desired, condition) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    match expected { Some(item) => { if item.version.opaque == version.opaque { return Err("recoverable followup version did not change"); } } None() => {} }
    return Ok(version);
}

public flow admit(id: string, workspace: string, path: string, request: string, chat: MemoryEntry<string, ChatFrame>, policy: Policy, binding: string) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable chat missing or invalid"); } };
    let chat_error = admission_chat_error(current, chat); if chat_error != "" { return Err(chat_error); }
    match load(policy, binding) { Ok(None()) => {} Ok(Some(_)) => { return Err("recoverable followup already admitted; no retry"); } Err(error) => { return Err(error); } }
    let wide = chat.value.chat.format >= 13;
    let row = running_record_mode(id, workspace, path, request, chat.version.opaque, wide, chat.value.chat.format == 18);
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

public flow claim(ticket: Ticket, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current_chat = match load_chat(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable chat missing or invalid"); } };
    let chat_error = claim_chat_error(current_chat, ticket.chat, ticket.frame.work, "recoverable followup"); if chat_error != "" { return Err(chat_error); }
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable followup missing or invalid"); } };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque { return Err("recoverable followup reservation changed; no retry"); }
    return Ok(true);
}

public flow finish(ticket: Ticket, summary: string, spent: Ledger, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return Err(error); } }
    let events = match work_batch(records, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let row = completed_record(ticket.frame.work, summary, spent);
    let frame = Frame { format = 1, policy_binding = binding, parent_work_version = ticket.frame.parent_work_version, parent_check_version = ticket.frame.parent_check_version, work = row, events = events };
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable followup missing or invalid"); } };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque { return Err("recoverable followup reservation changed; no retry"); }
    match write(frame, Some(current), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let current = match load(policy, binding) { Ok(Some(value)) => value, _ => { return Err("interrupted followup missing"); } }; let old = current.value.work;
    let row = match abandoned_record(old, id, "followup") { Ok(value) => value, Err(error) => { return Err(error); } };
    let frame = Frame { format = current.value.format, policy_binding = binding, parent_work_version = current.value.parent_work_version, parent_check_version = current.value.parent_check_version, work = row, events = current.value.events };
    return match write(frame, Some(current), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
