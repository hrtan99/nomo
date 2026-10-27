module nomo.session.work_record_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.edit_operation.{selector_error, same_binding};
import nomo.session.edit_operation_store.inspect as inspect_edit;
import nomo.session.work_record.{Record, Captured, validate, confirm, same_record};

public type Ticket = { row: Record, version: MemoryVersion };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Work = std.memory.region<Schema>(stable_id = "nomo-work-record-v1", store = "work-record");
flow key(id: string) -> string { return "work:" + id; }
flow read(id: string) -> Option<MemoryEntry<string, Record>> { return get_entry(Work.Rows, key(id)); }

public flow available(id: string, workspace: string, path: string) -> Result<bool, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    return match read(id) { None() => Ok(true), Some(_) => Err("work record key already exists; no adoption or retry") };
}

flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match validate(row) { Ok(_) => {} Err(error) => { return Err(error); } }
    let selected = key(row.binding.id);
    let intent = prepare_put(Work.Rows, selected, row, condition);
    let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("work record commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("work record commit refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != selected || receipt.target.region != "nomo-work-record-v1" || receipt.target.store != ["Rows"] {
        return Err("work record receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite work record receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(value) => value,
        _ => { return Err("work record written-version receipt required"); } };
    let observed = match read(row.binding.id) { Some(value) => value, None() => { return Err("work record readback missing; no retry"); } };
    if observed.key != selected || !same_record(observed.value, row) || observed.version.opaque != version.opaque {
        return Err("work record readback mismatch; no retry");
    }
    return Ok(version);
}

public flow publish(row: Record) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if row.phase != "summary-unconfirmed" { return Err("initial work record must leave summary unconfirmed"); }
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { row = row, version = version });
}

public flow complete(ticket: Ticket, summary: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if ticket.row.phase != "summary-unconfirmed" { return Err("work update requires the original partial ticket"); }
    let row = match confirm(ticket.row, summary) { Ok(value) => value, Err(error) => { return Err(error); } };
    let before = match read(ticket.row.binding.id) { Some(value) => value, None() => { return Err("partial work record missing; no retry"); } };
    if before.key != key(ticket.row.binding.id) || !same_record(before.value, ticket.row) || before.version.opaque != ticket.version.opaque {
        return Err("partial work record binding or version changed; no retry");
    }
    let version = match write(row, Match(before.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
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
