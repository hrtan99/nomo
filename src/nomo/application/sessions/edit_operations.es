module nomo.application.sessions.edit_operations;

import std.memory.{WriteCondition, Missing};
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.application.sessions.persistence.commit_once;
import nomo.session.edit_operation.{Binding, Record};
import nomo.domain.sessions.edit_operation.{selector_error, binding_error, record_error, same_record};
import nomo.domain.mutations.edit_contract.Selector;
import nomo.domain.sessions.edit_operation_store.Ticket;

// Both namespaces share transitions, but each adapter has one fixed native store.
public flow available<S ~ CasRows<Record>>(rows: S) -> Result<bool, string> {
    return match rows.read() { Ok(None()) => Ok(true), Ok(Some(_)) => Err("edit operation slot already consumed; no retry"), Err(error) => Err(error) };
}

public flow begin<S ~ CasRows<Record>>(rows: S, binding: Binding) -> Result<Ticket, string> {
    let invalid = binding_error(binding); if invalid != "" { return Err(invalid); }
    match available(rows) { Ok(_) => (), Err(error) => { return Err(error); } }
    let row = Record { format = 1, phase = "intent", binding };
    let version = match commit_once<Record, S>(rows, row, Missing, None()) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { binding, version });
}

public flow complete<S ~ CasRows<Record>>(rows: S, ticket: Ticket) -> Result<bool, string> {
    let invalid = binding_error(ticket.binding); if invalid != "" { return Err(invalid); }
    let before = match rows.read() { Ok(Some(value)) => value, _ => { return Err("edit intent missing; no retry"); } };
    let expected = Record { format = 1, phase = "intent", binding = ticket.binding };
    if before.key != "operation" || !same_record(before.value, expected) || before.version.opaque != ticket.version.opaque { return Err("edit intent binding or version changed; no retry"); }
    let row = Record { format = 1, phase = "completed", binding = ticket.binding };
    return match commit_once<Record, S>(rows, row, WriteCondition.Match(before.version), Some(before.version)) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

// Status reads never mutate or authorize an edit; completion is historical fact.
public flow inspect<S ~ CasRows<Record>>(rows: S, selector: Selector) -> Result<Option<Record>, string> {
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
