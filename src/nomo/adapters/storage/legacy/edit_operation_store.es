module nomo.adapters.storage.legacy.edit_operation_store;

import std.memory.{WriteCondition, MemoryEntry, Missing, Match};
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.domain.sessions.cas_rows.{Target, Submission};
import nomo.adapters.storage.legacy.cas_rows.submit_native;
import nomo.application.sessions.persistence.commit_once;
import nomo.session.edit_operation.{Binding, Record};
import nomo.domain.sessions.edit_operation.{selector_error, binding_error, record_error, same_record};
import nomo.domain.mutations.edit_contract.Selector;
import nomo.domain.sessions.edit_operation_store.Ticket;
import nomo.application.sessions.ports.session_edit_operation_store.EditJournal;
import nomo.session.edit_operation_store.{Operations, Followups};

public type FirstEditJournal = {};

public type FollowupEditJournal = {};

impl FirstEditJournal ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-edit-operation-v1", key = "operation", label = "edit journal" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Operations.Rows, "operation", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(Operations.Rows.get_entry("operation")); }
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
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(Followups.Rows.get_entry("operation")); }
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
    match available_rows(rows) { Ok(_) => (), Err(error) => { return Err(error); } }
    let row = Record { format = 1, phase = "intent", binding };
    let version = match commit_once<Record, S>(rows, row, Missing, None()) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { binding, version });
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

public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> { let journal = FirstEditJournal {}; return journal.inspect(Selector { id, workspace, path }); }
