module nomo.adapters.storage.legacy.work_chain_journal;

import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_native;
import std.memory.{WriteCondition, MemoryVersion, MemoryEntry, Missing};
import nomo.session.edit_operation.Binding;
import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.sessions.work_chain_journal_contract.{CapturedJournal, invalid as journal_error};
import nomo.session.work_chain_journal.{Record, Journal};
import nomo.domain.sessions.work_chain_journal.Ticket;

flow key(turn: i32) -> string { return if turn == 1 { "turn:1" } else { "turn:2" }; }

flow read(turn: i32) -> Option<MemoryEntry<string, Record>> { return Journal.Rows.get_entry(key(turn)); }

flow invalid(row: Record) -> string { return journal_error(captured(row)); }

public flow captured(row: Record) -> CapturedJournal {
    return CapturedJournal { format = row.format, chain = row.chain, turn = row.turn, phase = row.phase, binding = row.binding };
}

flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(row); if error != "" { return Err(error); }
    let selected = key(row.turn);
    return commit_native<Record>(Journal.Rows, Target { store = ["Rows"], region = "nomo-work-chain-edit-v2", key = selected, label = "v2 edit journal" }, row, condition);
}

// Fixed turn slots remain consumed across changed operation IDs.
public flow available(turn: i32) -> Result<bool, string> {
    if turn != 1 && turn != 2 { return Err("v2 edit journal permits only two turns"); }
    return match read(turn) { None() => Ok(true), Some(_) => Err("v2 edit journal slot consumed; no retry") };
}

public flow begin(chain: string, turn: i32, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = Record { format = 2, chain, turn, phase = "intent", binding };
    let error = invalid(row); if error != "" { return Err(error); }
    match available(turn) { Ok(_) => (), Err(error) => { return Err(error); } }
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { row, version });
}

public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(ticket.row); if error != "" { return Err(error); }
    if ticket.row.phase != "intent" { return Err("v2 edit completion requires the exact intent"); }
    let before = match read(ticket.row.turn) { Some(value) => value, None() => { return Err("v2 edit intent missing; no retry"); } };
    if before.key != key(ticket.row.turn) || before.value != ticket.row || before.version.opaque != ticket.version.opaque {
        return Err("v2 edit intent or version changed; no retry");
    }
    let row = ticket.row { format = 2, phase = "completed" };
    let version = match write(row, WriteCondition.Match(before.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
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

// Fixed-slot read only; storage errors remain native errors, never empty results.
public flow observe(turn: i32) -> Result<Option<MemoryEntry<string, Record>>, string> {
    if turn != 1 && turn != 2 { return Err("v2 edit journal permits only two turns"); }
    return Ok(read(turn));
}
