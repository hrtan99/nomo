module nomo.session.work_chain_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.edit_operation.selector_error;
import nomo.session.work_record.Record as WorkRecord;
import nomo.session.work_chain.{Record, Caps, initial, successor, validate, linked};
import nomo.session.work_chain.publish_partial as partial_row;
import nomo.session.work_chain.confirm as confirmed_row;
import nomo.session.work_chain_journal.inspect as inspect_journal;
import nomo.session.work_chain_journal.available as journal_available;
import nomo.session.work_chain_journal.{observe as observed_journal, captured as captured_journal};
import nomo.session.work_chain_observation.{SessionObservation, observe as observe_sessions};
import nomo.session.work_chain_selection.{Snapshot, ObservedRow, ObservedJournal, Selector, select, consistent};
import nomo.session.work_chain_selection.journal_error as selected_journal_error;

public type Ticket = { row: Record, version: MemoryVersion, parent: Option<MemoryEntry<string, Record>> };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Chain = std.memory.region<Schema>(stable_id = "nomo-work-chain-v2", store = "work-chain");
flow key(turn: i32) -> string { return if turn == 1 { "turn:1" } else { "turn:2" }; }
flow read(turn: i32) -> Option<MemoryEntry<string, Record>> { return get_entry(Chain.Rows, key(turn)); }

flow journal_error(row: Record) -> string {
    let journal = match inspect_journal(row.chain, row.turn, row.id, row.workspace, row.path) {
        Ok(value) => value, Err(error) => { return error; }
    };
    let projected = match journal { Some(value) => Some(captured_journal(value)), None() => None() };
    return selected_journal_error(row, projected);
}

// The first fixed turn row is also the global owner/root admission. It is
// never removed or adopted under another root ID in this private store.
flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = validate(row); if error != "" { return Err(error); }
    let selected = key(row.turn); let intent = prepare_put(Chain.Rows, selected, row, condition);
    let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("v2 work-chain commit unknown; admission retained, no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("v2 work-chain commit refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != selected ||
        receipt.target.region != "nomo-work-chain-v2" || receipt.target.store != ["Rows"] { return Err("v2 work-chain receipt mismatch; no retry"); }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite v2 work-chain receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(value) => value, _ => { return Err("v2 work-chain written-version receipt required"); } };
    let after = match read(row.turn) { Some(value) => value, None() => { return Err("v2 work-chain readback missing; no retry"); } };
    if after.key != selected || after.value != row || after.version.opaque != version.opaque { return Err("v2 work-chain full readback mismatch; no retry"); }
    return Ok(version);
}

public flow read_parent(id: string, workspace: string, path: string) -> Result<MemoryEntry<string, Record>, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    let before = match read(1) { Some(value) => value, None() => { return Err("v2 parent missing; v1 records are not executable parents"); } };
    let invalid = validate(before.value); if invalid != "" { return Err(invalid); }
    let row = before.value;
    if before.key != key(1) || row.turn != 1 || row.phase != "summary-confirmed" || row.id != id || row.chain != id || row.workspace != workspace || row.path != path {
        return Err("only the matching fully confirmed first v2 turn can continue; no partial or third turn");
    }
    let journal = journal_error(row); if journal != "" { return Err(journal); }
    let after = match read(1) { Some(value) => value, None() => { return Err("v2 parent disappeared; no retry"); } };
    if after != before { return Err("v2 parent changed during reload; no retry"); }
    return Ok(before);
}

flow parent_error(ticket: Ticket, row: Record) -> string {
    if row.turn == 1 {
        if ticket.parent != None() { return "v2 root ticket unexpectedly has a parent"; }
        return "";
    }
    let parent = match ticket.parent { Some(value) => value, None() => { return "v2 successor ticket has no parent"; } };
    let error = linked(parent.value, parent.version.opaque, row); if error != "" { return error; }
    let current = match read_parent(row.parent_id, row.workspace, row.path) { Ok(value) => value, Err(error) => { return error; } };
    if current != parent { return "v2 parent full value or opaque version changed; no retry"; }
    return "";
}

public flow claim(ticket: Ticket) -> Result<bool, string> {
    let error = validate(ticket.row); if error != "" { return Err(error); }
    let parent = parent_error(ticket, ticket.row); if parent != "" { return Err(parent); }
    let before = match read(ticket.row.turn) { Some(value) => value, None() => { return Err("v2 turn admission missing; no retry"); } };
    if before.key != key(ticket.row.turn) || before.value != ticket.row || before.version.opaque != ticket.version.opaque {
        return Err("v2 turn admission full value or opaque version changed; no retry");
    }
    let journal = journal_error(ticket.row); if journal != "" { return Err(journal); }
    return Ok(true);
}

public flow admit_new(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match initial(id, workspace, path, request, allowed, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    if read(1) != None() || read(2) != None() { return Err("v2 root/turn slot already consumed; no changed-ID retry"); }
    match journal_available(1) { Ok(_) => {} Err(error) => { return Err(error); } }
    match journal_available(2) { Ok(_) => {} Err(error) => { return Err(error); } }
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { row = row, version = version, parent = None() });
}

// The caller preflights the parent facts from exactly expected_parent. Missing
// admission is durable before Model/File; all later failures consume this slot.
public flow admit_continue(parent_id: string, id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps,
    expected_parent: MemoryEntry<string, Record>) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    if read(2) != None() { return Err("v2 successor already admitted; no same/changed-ID retry or third turn"); }
    match journal_available(2) { Ok(_) => {} Err(error) => { return Err(error); } }
    let parent = match read_parent(parent_id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    if parent != expected_parent { return Err("v2 parent differs from the capacity-preflight snapshot; no admission"); }
    let row = match successor(parent.value, parent.version.opaque, id, request, allowed, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    let ticket = Ticket { row = row, version = version, parent = Some(parent) };
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    return Ok(ticket);
}

public flow publish_partial(ticket: Ticket, work: WorkRecord) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match partial_row(ticket.row, work) { Ok(value) => value, Err(error) => { return Err(error); } };
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    let parent = parent_error(ticket, row); if parent != "" { return Err(parent); }
    let journal = journal_error(row); if journal != "" { return Err(journal); }
    let version = match write(row, Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("v2 partial publication version did not change"); }
    return Ok(Ticket { row = row, version = version, parent = ticket.parent });
}

public flow complete(ticket: Ticket, summary: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match confirmed_row(ticket.row, summary) { Ok(value) => value, Err(error) => { return Err(error); } };
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    let parent = parent_error(ticket, row); if parent != "" { return Err(parent); }
    let journal = journal_error(row); if journal != "" { return Err(journal); }
    let version = match write(row, Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("v2 summary confirmation version did not change"); }
    let after = parent_error(ticket, row); if after != "" { return Err(after); }
    return Ok(true);
}

// Validate the complete two-slot graph and journals before returning captured
// data. Missing work never establishes that an edit did not occur.
public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    let root = read(1); let child = read(2);
    let first = match root { Some(value) => value, None() => {
        if child != None() { return Err("v2 successor exists without its root"); } return Ok(None()); } };
    let invalid = validate(first.value); if invalid != "" { return Err(invalid); }
    if first.key != key(1) || first.value.turn != 1 { return Err("v2 root slot mismatch"); }
    let first_journal = journal_error(first.value); if first_journal != "" { return Err(first_journal); }
    var selected = first.value; var found = first.value.id == id;
    match child {
        Some(value) => {
            if value.key != key(2) || value.value.turn != 2 { return Err("v2 successor slot mismatch"); }
            let invalid_child = linked(first.value, first.version.opaque, value.value); if invalid_child != "" { return Err(invalid_child); }
            let journal = journal_error(value.value); if journal != "" { return Err(journal); }
            if value.value.id == id { selected = value.value; found = true; }
        }
        None() => {}
    }
    if !found || selected.workspace != workspace || selected.path != path { return Err("v2 chain selected identity or workspace mismatch"); }
    if read(1) != root || read(2) != child { return Err("v2 chain changed during show"); }
    return Ok(Some(selected));
}

flow observed_snapshot() -> Result<Snapshot, string> {
    let root = read(1); let child = read(2);
    let root_edit = match observed_journal(1) { Ok(value) => value, Err(error) => { return Err(error); } };
    let child_edit = match observed_journal(2) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Snapshot {
        root = match root { Some(value) => Some(ObservedRow { key = value.key, version = value.version.opaque, value = value.value }), None() => None() },
        child = match child { Some(value) => Some(ObservedRow { key = value.key, version = value.version.opaque, value = value.value }), None() => None() },
        root_journal = match root_edit { Some(value) => Some(ObservedJournal { key = value.key, version = value.version.opaque, value = captured_journal(value.value) }), None() => None() },
        child_journal = match child_edit { Some(value) => Some(ObservedJournal { key = value.key, version = value.version.opaque, value = captured_journal(value.value) }), None() => None() } });
}
public flow snapshot(workspace: string, path: string) -> Result<Snapshot, string> {
    return handle { observe_sessions(workspace, path) } with {
        SessionObservation.capture(pass) => { resume observed_snapshot(); }
    };
}
public flow discover(workspace: string, path: string, selector: Selector) -> Result<Snapshot, string> {
    let before = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let selected = match select(before, workspace, path, selector) { Ok(value) => value, Err(error) => { return Err(error); } };
    for row in selected limit Iterations(2) {
        let actual = match inspect(row.id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
        if actual != Some(row) { return Err("v2 discovery selected row differs from inspect authority"); }
    }
    let after = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let change = consistent(before, after); if change != "" { return Err(change); }
    return Ok(before);
}
public flow latest_parent(workspace: string, path: string) -> Result<string, string> {
    let before = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let selected = match select(before, workspace, path, Selector.Parent) { Ok(value) => value, Err(error) => { return Err(error); } };
    let actual = match read_parent(selected[0].id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let root = match before.root { Some(value) => value, None() => { return Err("v2 discovery parent missing"); } };
    if actual.key != root.key || actual.version.opaque != root.version || actual.value != root.value { return Err("v2 discovered parent changed before continuation"); }
    let after = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let change = consistent(before, after); if change != "" { return Err(change); }
    return Ok(actual.value.id);
}
