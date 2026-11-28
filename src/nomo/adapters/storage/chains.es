module nomo.adapters.storage.chains;

import nomo.adapters.storage.checks.inspect as checks_inspect;
import nomo.adapters.storage.followup.inspect;
import nomo.adapters.storage.followup_checks.inspect as followup_checks_inspect;
import nomo.adapters.storage.session_records.commit_native;
import nomo.adapters.storage.work_admission.inspect as work_admission_inspect;
import nomo.application.sessions.chain.{
    ConfirmedParentAuthority,
    InspectAuthority,
    SnapshotCapture,
    discover as chain_discover,
    latest_parent as chain_latest_parent,
    observe as chain_observe
};
import nomo.application.sessions.ports.{DiscoveryAuthority, SessionObservation, Target};
import nomo.domain.editing.selector_error;
import nomo.domain.sessions.chain.{
    CapturedJournal,
    ObservationPass,
    ObservedJournal,
    ObservedRow,
    Selector,
    Snapshot,
    confirm,
    initial,
    initial_user_context,
    invalid as chain_invalid,
    journal_error as chain_journal_error,
    linked,
    publish_partial as chain_publish_partial,
    successor,
    work_chain_validate
};
import nomo.session.edit_operation.Binding;
import nomo.session.recovery_decision.{Decision, Decisions};
import nomo.session.work_chain.{Caps, Record as work_chain_Record};
import nomo.session.work_chain_journal.{Journal, Record};
import nomo.session.work_chain_store.Chain;
import nomo.session.work_record.Record as work_record_Record;
import std.memory.{MemoryEntry, MemoryVersion, Missing, WriteCondition};

flow recovery_decision_read(target: string) -> Option<MemoryEntry<string, Decision>> { return Decisions.Rows.get_entry(target); }

flow validate_target(target: string, id: string) -> string {
    if target == "followup" || target == "followup-check" {
        let work = match inspect() { Ok(Some(value)) => value, _ => { return "followup work record missing or invalid"; } };
        if id == "" || work.id != id { return "followup work identity differs"; }
        if target == "followup" {
            if work.phase != "running" { return "followup work is not unresolved"; }
        } else {
            let check = match followup_checks_inspect() { Ok(Some(value)) => value, _ => { return "followup check record missing or invalid"; } };
            if check.phase != "running" || check.id != id { return "followup check is not unresolved"; }
        }
        return "";
    }
    let work = match work_admission_inspect() { Ok(Some(value)) => value, _ => { return "work record missing or invalid"; } };
    if id == "" || work.id != id { return "work identity differs"; }
    if target == "work" {
        if work.phase != "running" { return "work is not unresolved"; }
    } else if target == "check" {
        let check = match checks_inspect() { Ok(Some(value)) => value, _ => { return "check record missing or invalid"; } };
        if check.phase != "running" || check.id != id { return "check is not unresolved"; }
    } else { return "unknown recovery target"; }
    return "";
}

public flow get(target: string) -> Result<Option<Decision>, string> {
    if target != "work" && target != "check" && target != "followup" && target != "followup-check" { return Err("unknown recovery target"); }
    let row = recovery_decision_read(target);
    match row {
        None() => { return Ok(None()); }
        Some(value) => {
            let item = value.value;
            if value.key != target || item.format != 1 || item.target != target || item.choice != "abandon" || item.id == "" { return Err("invalid recovery decision"); }
            let error = validate_target(target, item.id); if error != "" { return Err(error); }
            if recovery_decision_read(target) != row { return Err("recovery decision changed during inspection"); }
            return Ok(Some(item));
        }
    }
}

public flow abandon(target: string, id: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let error = validate_target(target, id); if error != "" { return Err(error); }
    if recovery_decision_read(target) != None() { return Err("recovery decision already recorded; no retry"); }
    let item = Decision { format = 1, id, target, choice = "abandon" };
    return commit_native<Decision>(Decisions.Rows, Target { store = ["Rows"], region = "nomo-recovery-decision-v1", key = target, label = "decision" }, item, Missing);
}

flow work_chain_journal_key(turn: i32) -> string { return if turn == 1 { "turn:1" } else { "turn:2" }; }

flow work_chain_journal_read(turn: i32) -> Option<MemoryEntry<string, Record>> { return Journal.Rows.get_entry(work_chain_journal_key(turn)); }

flow invalid(row: Record) -> string { return chain_invalid(captured(row)); }

public flow captured(row: Record) -> CapturedJournal {
    return CapturedJournal { format = row.format, chain = row.chain, turn = row.turn, phase = row.phase, binding = row.binding };
}

flow work_chain_journal_write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let error = invalid(row); if error != "" { return Err(error); }
    let selected = work_chain_journal_key(row.turn);
    return commit_native<Record>(Journal.Rows, Target { store = ["Rows"], region = "nomo-work-chain-edit-v2", key = selected, label = "v2 edit journal" }, row, condition);
}

// Fixed turn slots remain consumed across changed operation IDs.
public flow available(turn: i32) -> Result<bool, string> {
    if turn != 1 && turn != 2 { return Err("v2 edit journal permits only two turns"); }
    return match work_chain_journal_read(turn) { None() => Ok(true), Some(_) => Err("v2 edit journal slot consumed; no retry") };
}

public flow begin(chain: string, turn: i32, binding: Binding) -> Result<WorkChainJournalTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let row = Record { format = 2, chain, turn, phase = "intent", binding };
    let error = invalid(row); if error != "" { return Err(error); }
    match available(turn) { Ok(_) => (), Err(error) => { return Err(error); } }
    let version = match work_chain_journal_write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkChainJournalTicket { row, version });
}

public flow work_chain_journal_complete(ticket: WorkChainJournalTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let error = invalid(ticket.row); if error != "" { return Err(error); }
    if ticket.row.phase != "intent" { return Err("v2 edit completion requires the exact intent"); }
    let before = match work_chain_journal_read(ticket.row.turn) { Some(value) => value, None() => { return Err("v2 edit intent missing; no retry"); } };
    if before.key != work_chain_journal_key(ticket.row.turn) || before.value != ticket.row || before.version.opaque != ticket.version.opaque {
        return Err("v2 edit intent or version changed; no retry");
    }
    let row = ticket.row { format = 2, phase = "completed" };
    let version = match work_chain_journal_write(row, WriteCondition.Match(before.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == before.version.opaque { return Err("v2 edit completion version did not change"); }
    return Ok(true);
}

public flow work_chain_journal_inspect(chain: string, turn: i32, id: string, workspace: string, path: string) -> Result<Option<Record>, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    if turn != 1 && turn != 2 { return Err("v2 edit journal permits only two turns"); }
    let before = match work_chain_journal_read(turn) { Some(value) => value, None() => { return Ok(None()); } };
    let invalid_row = invalid(before.value); if invalid_row != "" { return Err(invalid_row); }
    let row = before.value;
    if before.key != work_chain_journal_key(turn) || row.chain != chain || row.turn != turn || row.binding.id != id || row.binding.workspace != workspace || row.binding.path != path {
        return Err("v2 edit journal selected binding mismatch");
    }
    let after = match work_chain_journal_read(turn) { Some(value) => value, None() => { return Err("v2 edit journal disappeared during inspect"); } };
    if after != before { return Err("v2 edit journal changed during inspect"); }
    return Ok(Some(row));
}

// Fixed-slot read only; storage errors remain native errors, never empty results.
public flow observe(turn: i32) -> Result<Option<MemoryEntry<string, Record>>, string> {
    if turn != 1 && turn != 2 { return Err("v2 edit journal permits only two turns"); }
    return Ok(work_chain_journal_read(turn));
}

flow work_chain_store_key(turn: i32) -> string { return if turn == 1 { "turn:1" } else { "turn:2" }; }

flow work_chain_store_read(turn: i32) -> Option<MemoryEntry<string, work_chain_Record>> { return Chain.Rows.get_entry(work_chain_store_key(turn)); }

flow journal_error(row: work_chain_Record) -> string {
    let journal = match work_chain_journal_inspect(row.chain, row.turn, row.id, row.workspace, row.path) {
        Ok(value) => value, Err(error) => { return error; }
    };
    let projected = match journal { Some(value) => Some(captured(value)), None() => None() };
    return chain_journal_error(row, projected);
}

// The first fixed turn row is also the global owner/root admission. It is
// never removed or adopted under another root ID in this private store.
flow work_chain_store_write(row: work_chain_Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let error = work_chain_validate(row); if error != "" { return Err(error); }
    let selected = work_chain_store_key(row.turn);
    return commit_native<work_chain_Record>(Chain.Rows, Target { store = ["Rows"], region = "nomo-work-chain-v2", key = selected, label = "v2 work-chain" }, row, condition);
}

public flow read_parent_access(id: string, workspace: string, path: string) -> ParentAccess {
    let error = selector_error(id, workspace, path); if error != "" { return ParentAccess.Refused(error); }
    let before = match work_chain_store_read(1) { Some(value) => value, None() => { return ParentAccess.Refused("v2 parent missing; v1 records are not executable parents"); } };
    if before.value.format == 3 { return ParentAccess.UserContext; }
    let invalid = work_chain_validate(before.value); if invalid != "" { return ParentAccess.Refused(invalid); }
    let row = before.value;
    if before.key != work_chain_store_key(1) || row.turn != 1 || row.phase != "summary-confirmed" || row.id != id || row.chain != id || row.workspace != workspace || row.path != path {
        return ParentAccess.Refused("only the matching fully confirmed first v2 turn can continue; no partial or third turn");
    }
    let journal = journal_error(row); if journal != "" { return ParentAccess.Refused(journal); }
    let after = match work_chain_store_read(1) { Some(value) => value, None() => { return ParentAccess.Refused("v2 parent disappeared; no retry"); } };
    if after != before { return ParentAccess.Refused("v2 parent changed during reload; no retry"); }
    return ParentAccess.Found(before);
}

public flow read_parent(id: string, workspace: string, path: string) -> Result<MemoryEntry<string, work_chain_Record>, string> {
    return match read_parent_access(id, workspace, path) {
        ParentAccess.Found(value) => Ok(value),
        ParentAccess.Refused(error) => Err(error),
        ParentAccess.UserContext => Err("user-context work cannot continue or resume"),
    };
}

flow parent_error(ticket: WorkChainStoreTicket, row: work_chain_Record) -> string {
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

public flow claim(ticket: WorkChainStoreTicket) -> Result<bool, string> {
    let error = work_chain_validate(ticket.row); if error != "" { return Err(error); }
    let parent = parent_error(ticket, ticket.row); if parent != "" { return Err(parent); }
    let before = match work_chain_store_read(ticket.row.turn) { Some(value) => value, None() => { return Err("v2 turn admission missing; no retry"); } };
    if before.key != work_chain_store_key(ticket.row.turn) || before.value != ticket.row || before.version.opaque != ticket.version.opaque {
        return Err("v2 turn admission full value or opaque version changed; no retry");
    }
    let journal = journal_error(ticket.row); if journal != "" { return Err(journal); }
    return Ok(true);
}

flow admit_first(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps, user_context: bool) -> Result<WorkChainStoreTicket, string> {
    let proposed = if user_context { initial_user_context(id, workspace, path, request, allowed, policy) } else { initial(id, workspace, path, request, allowed, policy) };
    let row = match proposed { Ok(value) => value, Err(error) => { return Err(error); } };
    if work_chain_store_read(1) != None() || work_chain_store_read(2) != None() { return Err("v2 root/turn slot already consumed; no changed-ID retry"); }
    match available(1) { Ok(_) => (), Err(error) => { return Err(error); } }
    match available(2) { Ok(_) => (), Err(error) => { return Err(error); } }
    let version = match work_chain_store_write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkChainStoreTicket { row, version, parent = None() });
}

public flow admit_new(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps) -> Result<WorkChainStoreTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return admit_first(id, workspace, path, request, allowed, policy, false);
}

public flow admit_user_context(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps) -> Result<WorkChainStoreTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return admit_first(id, workspace, path, request, allowed, policy, true);
}

// The caller preflights the parent facts from exactly expected_parent. Missing
// admission is durable before Model/File; all later failures consume this slot.
public flow admit_continue(parent_id: string, id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps,
    expected_parent: MemoryEntry<string, work_chain_Record>) -> Result<WorkChainStoreTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    if work_chain_store_read(2) != None() { return Err("v2 successor already admitted; no same/changed-ID retry or third turn"); }
    match available(2) { Ok(_) => (), Err(error) => { return Err(error); } }
    let parent = match read_parent(parent_id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    if parent != expected_parent { return Err("v2 parent differs from the capacity-preflight snapshot; no admission"); }
    let row = match successor(parent.value, parent.version.opaque, id, request, allowed, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let version = match work_chain_store_write(row, Missing) { Ok(value) => value, Err(error) => { return Err(error); } };
    let ticket = WorkChainStoreTicket { row, version, parent = Some(parent) };
    match claim(ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    return Ok(ticket);
}

public flow publish_partial(ticket: WorkChainStoreTicket, work: work_record_Record) -> Result<WorkChainStoreTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let row = match chain_publish_partial(ticket.row, work) { Ok(value) => value, Err(error) => { return Err(error); } };
    match claim(ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    let parent = parent_error(ticket, row); if parent != "" { return Err(parent); }
    let journal = journal_error(row); if journal != "" { return Err(journal); }
    let version = match work_chain_store_write(row, WriteCondition.Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("v2 partial publication version did not change"); }
    return Ok(ticket { row, version });
}

public flow work_chain_store_complete(ticket: WorkChainStoreTicket, summary: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let row = match confirm(ticket.row, summary) { Ok(value) => value, Err(error) => { return Err(error); } };
    match claim(ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    let parent = parent_error(ticket, row); if parent != "" { return Err(parent); }
    let journal = journal_error(row); if journal != "" { return Err(journal); }
    let version = match work_chain_store_write(row, WriteCondition.Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("v2 summary confirmation version did not change"); }
    let after = parent_error(ticket, row); if after != "" { return Err(after); }
    return Ok(true);
}

// Validate the complete two-slot graph and journals before returning captured
// data. Missing work never establishes that an edit did not occur.
public flow work_chain_store_inspect(id: string, workspace: string, path: string) -> Result<Option<work_chain_Record>, string> {
    let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
    let root = work_chain_store_read(1); let child = work_chain_store_read(2);
    let first = match root { Some(value) => value, None() => {
        if child != None() { return Err("v2 successor exists without its root"); } return Ok(None()); } };
    let invalid = work_chain_validate(first.value); if invalid != "" { return Err(invalid); }
    if first.value.format == 3 {
        if child != None() { return Err("user-context work cannot have a successor"); }
        match available(2) { Ok(_) => (), Err(_) => { return Err("user-context work cannot have a second journal"); } }
    }
    if first.key != work_chain_store_key(1) || first.value.turn != 1 { return Err("v2 root slot mismatch"); }
    let first_journal = journal_error(first.value); if first_journal != "" { return Err(first_journal); }
    var selected = first.value; var found = first.value.id == id;
    match child {
        Some(value) => {
            if value.key != work_chain_store_key(2) || value.value.turn != 2 { return Err("v2 successor slot mismatch"); }
            let invalid_child = linked(first.value, first.version.opaque, value.value); if invalid_child != "" { return Err(invalid_child); }
            let journal = journal_error(value.value); if journal != "" { return Err(journal); }
            if value.value.id == id { selected = value.value; found = true; }
        }
        None() => (),
    }
    if !found || selected.workspace != workspace || selected.path != path { return Err("v2 chain selected identity or workspace mismatch"); }
    if work_chain_store_read(1) != root || work_chain_store_read(2) != child { return Err("v2 chain changed during show"); }
    if first.value.format == 3 { match available(2) { Ok(_) => (), Err(_) => { return Err("user-context second journal changed during show"); } } }
    return Ok(Some(selected));
}

flow observed_snapshot() -> Result<Snapshot, string> {
    let root = work_chain_store_read(1); let child = work_chain_store_read(2);
    let root_edit = match observe(1) { Ok(value) => value, Err(error) => { return Err(error); } };
    let child_edit = match observe(2) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Snapshot {
        root = match root { Some(value) => Some(ObservedRow { key = value.key, version = value.version.opaque, value = value.value }), None() => None() },
        child = match child { Some(value) => Some(ObservedRow { key = value.key, version = value.version.opaque, value = value.value }), None() => None() },
        root_journal = match root_edit { Some(value) => Some(ObservedJournal { key = value.key, version = value.version.opaque, value = captured(value.value) }), None() => None() },
        child_journal = match child_edit { Some(value) => Some(ObservedJournal { key = value.key, version = value.version.opaque, value = captured(value.value) }), None() => None() } });
}

public flow snapshot(workspace: string, path: string) -> Result<Snapshot, string> {
    return handle chain_observe(workspace, path) with {
        SessionObservation.capture(pass) => observed_snapshot();
    };
}

// Native adapters retain all original storage and journal validation. The copied
// observation is never a MemoryVersion or authority to admit a write.
flow capture_adapter(pass: ObservationPass) -> Result<Snapshot, string> ![Memory, Error<StorageError>, Error<IndexError>] ~ SnapshotCapture {
    return observed_snapshot();
}

flow inspect_adapter(id: string, workspace: string, path: string) -> Result<Option<work_chain_Record>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] ~ InspectAuthority {
    return work_chain_store_inspect(id, workspace, path);
}

flow confirmed_parent_adapter(id: string, workspace: string, path: string) -> Result<ObservedRow, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] ~ ConfirmedParentAuthority {
    let actual = match read_parent(id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(ObservedRow { key = actual.key, version = actual.version.opaque, value = actual.value });
}

public flow discover(workspace: string, path: string, selector: Selector) -> Result<Snapshot, string> {
    return chain_discover(workspace, path, selector) with {
        SessionObservation.capture(pass) => capture_adapter(pass);
        DiscoveryAuthority.inspect(id, selected_workspace, selected_path) => inspect_adapter(id, selected_workspace, selected_path);
        DiscoveryAuthority.confirmed_parent(id, selected_workspace, selected_path) => confirmed_parent_adapter(id, selected_workspace, selected_path);
    };
}

public flow latest_parent(workspace: string, path: string) -> Result<string, string> {
    return chain_latest_parent(workspace, path) with {
        SessionObservation.capture(pass) => capture_adapter(pass);
        DiscoveryAuthority.inspect(id, selected_workspace, selected_path) => inspect_adapter(id, selected_workspace, selected_path);
        DiscoveryAuthority.confirmed_parent(id, selected_workspace, selected_path) => confirmed_parent_adapter(id, selected_workspace, selected_path);
    };
}

public type WorkChainJournalTicket = { row: Record, version: MemoryVersion };

public type WorkChainStoreTicket = { row: work_chain_Record, version: MemoryVersion, parent: Option<MemoryEntry<string, work_chain_Record>> };

public enum ParentAccess { Found(MemoryEntry<string, work_chain_Record>), Refused(string), UserContext }
