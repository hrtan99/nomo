module nomo.session.edit_operation_store;

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry, Missing, Match};
import nomo.session.cas_rows.{CasRows, Target, Submission, submit_native, commit_once};
import nomo.session.edit_operation.{Binding, Record, selector_error, binding_error, record_error, same_record};
import nomo.tools.edit_contract.Selector;

public type Ticket = { binding: Binding, version: MemoryVersion };
public spec EditJournal {
    flow available(self) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow begin(self, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow complete(self, ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Operations = std.memory.region<Schema>(stable_id = "nomo-edit-operation-v1", store = "edit-operation");
let Followups = std.memory.region<Schema>(stable_id = "nomo-edit-followup-v1", store = "edit-followup");
public type FirstEditJournal = {};
public type FollowupEditJournal = {};

impl FirstEditJournal ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-edit-operation-v1", key = "operation", label = "edit journal" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Operations.Rows, "operation", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(get_entry(Operations.Rows, "operation")); }
    flow same(self, left: Record, right: Record) -> bool ![] { return same_record(left, right); }
}
impl FirstEditJournal ~ EditJournal {
    flow available(self) -> Result<bool, string> { return available_rows(self); }
    flow begin(self, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] { return begin_rows(self, binding); }
    flow complete(self, ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return complete_rows(self, ticket); }
    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> { return inspect_rows(self, selector); }
}

impl FollowupEditJournal ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-edit-followup-v1", key = "operation", label = "edit journal" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Followups.Rows, "operation", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(get_entry(Followups.Rows, "operation")); }
    flow same(self, left: Record, right: Record) -> bool ![] { return same_record(left, right); }
}
impl FollowupEditJournal ~ EditJournal {
    flow available(self) -> Result<bool, string> { return available_rows(self); }
    flow begin(self, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] { return begin_rows(self, binding); }
    flow complete(self, ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return complete_rows(self, ticket); }
    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> { return inspect_rows(self, selector); }
}

// Both namespaces share transitions, but each adapter has one fixed native store.
flow available_rows<S ~ CasRows<Record>>(rows: S) -> Result<bool, string> {
    return match rows.read() { Ok(None()) => Ok(true), Ok(Some(_)) => Err("edit operation slot already consumed; no retry"), Err(error) => Err(error) };
}
flow begin_rows<S ~ CasRows<Record>>(rows: S, binding: Binding) -> Result<Ticket, string> {
    let invalid = binding_error(binding); if invalid != "" { return Err(invalid); }
    match available_rows(rows) { Ok(_) => {} Err(error) => { return Err(error); } }
    let row = Record { format = 1, phase = "intent", binding = binding };
    let version = match commit_once<Record, S>(rows, row, Missing, None()) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { binding = binding, version = version });
}
flow complete_rows<S ~ CasRows<Record>>(rows: S, ticket: Ticket) -> Result<bool, string> {
    let invalid = binding_error(ticket.binding); if invalid != "" { return Err(invalid); }
    let before = match rows.read() { Ok(Some(value)) => value, _ => { return Err("edit intent missing; no retry"); } };
    let expected = Record { format = 1, phase = "intent", binding = ticket.binding };
    if before.key != "operation" || !same_record(before.value, expected) || before.version.opaque != ticket.version.opaque { return Err("edit intent binding or version changed; no retry"); }
    let row = Record { format = 1, phase = "completed", binding = ticket.binding };
    return match commit_once<Record, S>(rows, row, Match(before.version), Some(before.version)) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
// Status reads never mutate or authorize an edit; completion is historical fact.
flow inspect_rows<S ~ CasRows<Record>>(rows: S, selector: Selector) -> Result<Option<Record>, string> {
    let invalid = selector_error(selector.id, selector.workspace, selector.path); if invalid != "" { return Err(invalid); }
    let before = match rows.read() { Ok(Some(value)) => value, Ok(None()) => { return Ok(None()); } Err(error) => { return Err(error); } };
    if before.key != "operation" { return Err("edit operation key mismatch"); }
    let invalid_record = record_error(before.value); if invalid_record != "" { return Err(invalid_record); }
    let binding = before.value.binding;
    if binding.id != selector.id || binding.workspace != selector.workspace || binding.path != selector.path { return Err("edit operation identity or workspace binding mismatch"); }
    let after = match rows.read() { Ok(Some(value)) => value, _ => { return Err("edit operation disappeared during status"); } };
    if after.key != "operation" || after.version.opaque != before.version.opaque || !same_record(after.value, before.value) { return Err("edit operation changed during status"); }
    return Ok(Some(before.value));
}
public flow available() -> Result<bool, string> { let journal = FirstEditJournal {}; return journal.available(); }
public flow begin(binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] { let journal = FirstEditJournal {}; return journal.begin(binding); }
public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { let journal = FirstEditJournal {}; return journal.complete(ticket); }
public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> { let journal = FirstEditJournal {}; return journal.inspect(Selector { id = id, workspace = workspace, path = path }); }
