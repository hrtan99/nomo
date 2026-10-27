module nomo.session.work_chain_journal;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.edit_operation.{Binding, selector_error, binding_error};

public type Record = { format: i32, chain: string, turn: i32, phase: string, binding: Binding };
public type Ticket = { row: Record, version: MemoryVersion };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Journal = std.memory.region<Schema>(stable_id = "nomo-work-chain-edit-v2", store = "work-chain-edit");
flow key(turn: i32) -> string { return if turn == 1 { "turn:1" } else { "turn:2" }; }
flow read(turn: i32) -> Option<MemoryEntry<string, Record>> { return get_entry(Journal.Rows, key(turn)); }

flow invalid(row: Record) -> string {
    if row.format != 2 || (row.turn != 1 && row.turn != 2) || (row.phase != "intent" && row.phase != "completed") {
        return "invalid v2 edit journal format, turn or phase";
    }
    let binding = binding_error(row.binding); if binding != "" { return binding; }
    let chain = selector_error(row.chain, row.binding.workspace, row.binding.path); if chain != "" { return chain; }
    if (row.turn == 1 && row.chain != row.binding.id) || (row.turn == 2 && row.chain == row.binding.id) {
        return "v2 edit journal chain identity mismatch";
    }
    return "";
}

flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(row); if error != "" { return Err(error); }
    let selected = key(row.turn); let intent = prepare_put(Journal.Rows, selected, row, condition);
    let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("v2 edit journal commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("v2 edit journal commit refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != selected ||
        receipt.target.region != "nomo-work-chain-edit-v2" || receipt.target.store != ["Rows"] { return Err("v2 edit journal receipt mismatch; no retry"); }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite v2 edit receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(value) => value, _ => { return Err("v2 edit written-version receipt required"); } };
    let after = match read(row.turn) { Some(value) => value, None() => { return Err("v2 edit journal readback missing; no retry"); } };
    if after.key != selected || after.value != row || after.version.opaque != version.opaque { return Err("v2 edit journal readback mismatch; no retry"); }
    return Ok(version);
}

// Fixed turn slots remain consumed across changed operation IDs.
public flow available(turn: i32) -> Result<bool, string> {
    if turn != 1 && turn != 2 { return Err("v2 edit journal permits only two turns"); }
    return match read(turn) { None() => Ok(true), Some(_) => Err("v2 edit journal slot consumed; no retry") };
}
public flow begin(chain: string, turn: i32, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = Record { format = 2, chain = chain, turn = turn, phase = "intent", binding = binding };
    let error = invalid(row); if error != "" { return Err(error); }
    match available(turn) { Ok(_) => {} Err(error) => { return Err(error); } }
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { row = row, version = version });
}
public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(ticket.row); if error != "" { return Err(error); }
    if ticket.row.phase != "intent" { return Err("v2 edit completion requires the exact intent"); }
    let before = match read(ticket.row.turn) { Some(value) => value, None() => { return Err("v2 edit intent missing; no retry"); } };
    if before.key != key(ticket.row.turn) || before.value != ticket.row || before.version.opaque != ticket.version.opaque {
        return Err("v2 edit intent or version changed; no retry");
    }
    let row = Record { format = 2, chain = ticket.row.chain, turn = ticket.row.turn, phase = "completed", binding = ticket.row.binding };
    let version = match write(row, Match(before.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == before.version.opaque { return Err("v2 edit completion version did not change"); }
    return Ok(true);
}

public flow inspect(chain: string, turn: i32, id: string, workspace: string, path: string) -> Result<Option<Record>, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    if turn != 1 && turn != 2 { return Err("v2 edit journal permits only two turns"); }
    let before = match read(turn) { Some(value) => value, None() => { return Ok(None()); } };
    let invalid_row = invalid(before.value); if invalid_row != "" { return Err(invalid_row); }
    let row = before.value;
    if before.key != key(turn) || row.chain != chain || row.turn != turn || row.binding.id != id || row.binding.workspace != workspace || row.binding.path != path {
        return Err("v2 edit journal selected binding mismatch");
    }
    let after = match read(turn) { Some(value) => value, None() => { return Err("v2 edit journal disappeared during inspect"); } };
    if after != before { return Err("v2 edit journal changed during inspect"); }
    return Ok(Some(row));
}
