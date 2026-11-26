module nomo.adapters.storage.legacy.work_record_store;

import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.domain.sessions.cas_rows.{Target, Submission};
import nomo.adapters.storage.legacy.cas_rows.submit_native;
import nomo.application.sessions.persistence.commit_once;
import std.memory.{WriteCondition, MemoryVersion, MemoryEntry, Missing};
import nomo.domain.sessions.edit_operation.{selector_error, same_binding};
import nomo.adapters.storage.legacy.edit_operation_store.inspect as inspect_edit;
import nomo.session.work_record.Record;
import nomo.domain.sessions.work_record.{validate, confirm, same_record};
import nomo.domain.sessions.work_record_store.Ticket;
import nomo.session.work_record_store.Work;

flow key(id: string) -> string { return "work:" + id; }

flow read(id: string) -> Option<MemoryEntry<string, Record>> { return Work.Rows.get_entry(key(id)); }

public flow available(id: string, workspace: string, path: string) -> Result<bool, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    return match read(id) { None() => Ok(true), Some(_) => Err("work record key already exists; no adoption or retry") };
}

type RecordRows = { name: string };

impl RecordRows ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-work-record-v1", key = self.name, label = "work record" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Work.Rows, self.name, value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(Work.Rows.get_entry(self.name)); }
    flow same(self, left: Record, right: Record) -> bool ![] { return same_record(left, right); }
}

flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match validate(row) { Ok(_) => (), Err(error) => { return Err(error); } }
    let selected = key(row.binding.id);
    return commit_once<Record, RecordRows>(RecordRows { name = selected }, row, condition, None());
}

public flow publish(row: Record) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    if row.phase != "summary-unconfirmed" { return Err("initial work record must leave summary unconfirmed"); }
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { row, version });
}

public flow complete(ticket: Ticket, summary: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    if ticket.row.phase != "summary-unconfirmed" { return Err("work update requires the original partial ticket"); }
    let row = match confirm(ticket.row, summary) { Ok(value) => value, Err(error) => { return Err(error); } };
    let before = match read(ticket.row.binding.id) { Some(value) => value, None() => { return Err("partial work record missing; no retry"); } };
    if before.key != key(ticket.row.binding.id) || !same_record(before.value, ticket.row) || before.version.opaque != ticket.version.opaque {
        return Err("partial work record binding or version changed; no retry");
    }
    let version = match write(row, WriteCondition.Match(before.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == before.version.opaque { return Err("work confirmation version did not change"); }
    return Ok(true);
}

// Logical read-only: captured facts never authorize replay or assert current File state.
public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    let before = match read(id) { Some(value) => value, None() => { return Ok(None()); } };
    if before.key != key(id) { return Err("work record key mismatch"); }
    let captured = match validate(before.value) { Ok(value) => value, Err(error) => { return Err(error); } };
    if captured.binding.id != id || captured.binding.workspace != workspace || captured.binding.path != path {
        return Err("work record identity or workspace binding mismatch");
    }
    let journal = match inspect_edit(id, workspace, path) { Ok(Some(value)) => value,
        Ok(None()) => { return Err("work record has no confirmed edit journal"); } Err(error) => { return Err(error); } };
    if journal.phase != "completed" || !same_binding(journal.binding, captured.binding) { return Err("work record confirmed edit binding mismatch"); }
    let after = match read(id) { Some(value) => value, None() => { return Err("work record disappeared during show"); } };
    if after.key != before.key || after.version.opaque != before.version.opaque || !same_record(after.value, before.value) {
        return Err("work record changed during show");
    }
    return Ok(Some(before.value));
}
