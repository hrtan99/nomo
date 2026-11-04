module nomo.session.work_chain_store;

import nomo.session.cas_rows.{Target, commit_native};

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry, Missing, Match};
import nomo.session.edit_operation.selector_error;
import nomo.session.work_record.Record as WorkRecord;
import nomo.session.work_chain.{Record, Caps, initial, initial_user_context, successor, validate, linked};
import nomo.session.work_chain.publish_partial as partial_row;
import nomo.session.work_chain.confirm as confirmed_row;
import nomo.session.work_chain_journal.inspect as inspect_journal;
import nomo.session.work_chain_journal.available as journal_available;
import nomo.session.work_chain_journal.{observe as observed_journal, captured as captured_journal};
import nomo.session.work_chain_observation.{ObservationPass, SessionObservation, observe as observe_sessions};
import nomo.session.work_chain_selection.{Snapshot, ObservedRow, ObservedJournal, Selector};
import nomo.session.work_chain_discovery.{DiscoveryAuthority, SnapshotCapture, InspectAuthority, ConfirmedParentAuthority, discover as discover_controller, latest_parent as latest_parent_controller};
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
    let selected = key(row.turn);
    return commit_native<Record>(Chain.Rows, Target { store = ["Rows"], region = "nomo-work-chain-v2", key = selected, label = "v2 work-chain" }, row, condition);
}

public enum ParentAccess { Found(MemoryEntry<string, Record>), Refused(string), UserContext }
public flow read_parent_access(id: string, workspace: string, path: string) -> ParentAccess {
    let error = selector_error(id, workspace, path); if error != "" { return ParentAccess.Refused(error); }
    let before = match read(1) { Some(value) => value, None() => { return ParentAccess.Refused("v2 parent missing; v1 records are not executable parents"); } };
    if before.value.format == 3 { return ParentAccess.UserContext; }
    let invalid = validate(before.value); if invalid != "" { return ParentAccess.Refused(invalid); }
    let row = before.value;
    if before.key != key(1) || row.turn != 1 || row.phase != "summary-confirmed" || row.id != id || row.chain != id || row.workspace != workspace || row.path != path {
        return ParentAccess.Refused("only the matching fully confirmed first v2 turn can continue; no partial or third turn");
    }
    let journal = journal_error(row); if journal != "" { return ParentAccess.Refused(journal); }
    let after = match read(1) { Some(value) => value, None() => { return ParentAccess.Refused("v2 parent disappeared; no retry"); } };
    if after != before { return ParentAccess.Refused("v2 parent changed during reload; no retry"); }
    return ParentAccess.Found(before);
}

public flow read_parent(id: string, workspace: string, path: string) -> Result<MemoryEntry<string, Record>, string> {
    return match read_parent_access(id, workspace, path) {
        ParentAccess.Found(value) => Ok(value),
        ParentAccess.Refused(error) => Err(error),
        ParentAccess.UserContext => Err("user-context work cannot continue or resume"),
    };
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

flow admit_first(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps, user_context: bool) -> Result<Ticket, string> {
    let proposed = if user_context { initial_user_context(id, workspace, path, request, allowed, policy) } else { initial(id, workspace, path, request, allowed, policy) };
    let row = match proposed { Ok(value) => value, Err(error) => { return Err(error); } };
    if read(1) != None() || read(2) != None() { return Err("v2 root/turn slot already consumed; no changed-ID retry"); }
    match journal_available(1) { Ok(_) => {} Err(error) => { return Err(error); } }
    match journal_available(2) { Ok(_) => {} Err(error) => { return Err(error); } }
    let version = match write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ticket { row = row, version = version, parent = None() });
}
public flow admit_new(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return admit_first(id, workspace, path, request, allowed, policy, false);
}
public flow admit_user_context(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return admit_first(id, workspace, path, request, allowed, policy, true);
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
    if first.value.format == 3 {
        if child != None() { return Err("user-context work cannot have a successor"); }
        match journal_available(2) { Ok(_) => {} Err(_) => { return Err("user-context work cannot have a second journal"); } }
    }
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
    if first.value.format == 3 { match journal_available(2) { Ok(_) => {} Err(_) => { return Err("user-context second journal changed during show"); } } }
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
// Native adapters retain all original storage and journal validation. The copied
// observation is never a MemoryVersion or authority to admit a write.
flow capture_adapter(pass: ObservationPass) -> Result<Snapshot, string> ![Memory, Error<StorageError>, Error<IndexError>] ~ SnapshotCapture {
    return observed_snapshot();
}
flow inspect_adapter(id: string, workspace: string, path: string) -> Result<Option<Record>, string> ![Memory, Error<StorageError>, Error<IndexError>] ~ InspectAuthority {
    return inspect(id, workspace, path);
}
flow confirmed_parent_adapter(id: string, workspace: string, path: string) -> Result<ObservedRow, string> ![Memory, Error<StorageError>, Error<IndexError>] ~ ConfirmedParentAuthority {
    let actual = match read_parent(id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(ObservedRow { key = actual.key, version = actual.version.opaque, value = actual.value });
}
public flow discover(workspace: string, path: string, selector: Selector) -> Result<Snapshot, string> {
    return discover_controller(workspace, path, selector) with {
        SessionObservation.capture(pass) => { resume capture_adapter(pass); }
        DiscoveryAuthority.inspect(id, selected_workspace, selected_path) => { resume inspect_adapter(id, selected_workspace, selected_path); }
        DiscoveryAuthority.confirmed_parent(id, selected_workspace, selected_path) => { resume confirmed_parent_adapter(id, selected_workspace, selected_path); }
    };
}
public flow latest_parent(workspace: string, path: string) -> Result<string, string> {
    return latest_parent_controller(workspace, path) with {
        SessionObservation.capture(pass) => { resume capture_adapter(pass); }
        DiscoveryAuthority.inspect(id, selected_workspace, selected_path) => { resume inspect_adapter(id, selected_workspace, selected_path); }
        DiscoveryAuthority.confirmed_parent(id, selected_workspace, selected_path) => { resume confirmed_parent_adapter(id, selected_workspace, selected_path); }
    };
}
