module nomo.session.edit_operation_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.edit_operation.{Binding, Record, selector_error, binding_error, record_error, same_record};

public type Ticket = { binding: Binding, version: MemoryVersion };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Operations = std.memory.region<Schema>(stable_id = "nomo-edit-operation-v1", store = "edit-operation");
let Followups = std.memory.region<Schema>(stable_id = "nomo-edit-followup-v1", store = "edit-followup");

flow read(followup: bool) -> Option<MemoryEntry<string, Record>> { return if followup { get_entry(Followups.Rows, "operation") } else { get_entry(Operations.Rows, "operation") }; }

// Each transition has one prepared attempt. Unknown is not rollback and never
// authorizes another File action, a compensating write or an automatic retry.
flow write(row: Record, condition: WriteCondition, followup: bool) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let intent = if followup { prepare_put(Followups.Rows, "operation", row, condition) } else { prepare_put(Operations.Rows, "operation", row, condition) };
    let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("edit journal commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("edit journal commit refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "operation" || receipt.target.region != (if followup { "nomo-edit-followup-v1" } else { "nomo-edit-operation-v1" }) || receipt.target.store != ["Rows"] {
        return Err("edit journal receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite edit journal receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(value) => value,
        _ => { return Err("edit journal written-version receipt required"); } };
    let observed = match read(followup) { Some(value) => value, None() => { return Err("edit journal write readback missing"); } };
    if observed.key != "operation" || !same_record(observed.value, row) || observed.version.opaque != version.opaque {
        return Err("edit journal write readback mismatch; no retry");
    }
    return Ok(version);
}

// The caller supplies an externally fresh private store. Any existing row,
// including malformed/unresolved/completed work or a changed ID, consumes it.
public flow available_in(followup: bool) -> Result<bool, string> {
    return match read(followup) { None() => Ok(true),
        Some(_) => Err("edit operation slot already consumed; no retry") };
}

public flow begin_in(binding: Binding, followup: bool) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let invalid = binding_error(binding); if invalid != "" { return Err(invalid); }
    match available_in(followup) { Ok(_) => {} Err(error) => { return Err(error); } }
    let row = Record { format = 1, phase = "intent", binding = binding };
    let version = match write(row, Missing, followup) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(version);
}

public flow complete_in(binding: Binding, expected_version: MemoryVersion, followup: bool) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let invalid = binding_error(binding); if invalid != "" { return Err(invalid); }
    let before = match read(followup) { Some(value) => value, None() => { return Err("edit intent missing; no retry"); } };
    let expected = Record { format = 1, phase = "intent", binding = binding };
    if before.key != "operation" || !same_record(before.value, expected) || before.version.opaque != expected_version.opaque {
        return Err("edit intent binding or version changed; no retry");
    }
    let row = Record { format = 1, phase = "completed", binding = binding };
    let version = match write(row, Match(before.version), followup) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == before.version.opaque { return Err("edit completion version did not change"); }
    return Ok(true);
}

// Data only: this callgraph has no File, Approval, Console or Memory mutation.
// Completed describes the recorded operation, not a later external file state.
public flow inspect_in(id: string, workspace: string, path: string, followup: bool) -> Result<Option<Record>, string> {
    let invalid = selector_error(id, workspace, path); if invalid != "" { return Err(invalid); }
    let before = match read(followup) { Some(value) => value, None() => { return Ok(None()); } };
    if before.key != "operation" { return Err("edit operation key mismatch"); }
    let invalid_record = record_error(before.value); if invalid_record != "" { return Err(invalid_record); }
    let binding = before.value.binding;
    if binding.id != id || binding.workspace != workspace || binding.path != path {
        return Err("edit operation identity or workspace binding mismatch");
    }
    let after = match read(followup) { Some(value) => value, None() => { return Err("edit operation disappeared during status"); } };
    if after.key != "operation" || after.version.opaque != before.version.opaque || !same_record(after.value, before.value) {
        return Err("edit operation changed during status");
    }
    return Ok(Some(before.value));
}

public flow available() -> Result<bool, string> { return available_in(false); }
public flow begin(binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return match begin_in(binding, false) { Ok(version) => Ok(Ticket { binding = binding, version = version }), Err(error) => Err(error) };
}
public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return complete_in(ticket.binding, ticket.version, false); }
public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> { return inspect_in(id, workspace, path, false); }
