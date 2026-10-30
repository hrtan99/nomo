module nomo.session.work_chain_selection;

import std.collections.len as count;
import nomo.session.work_chain.{Record, validate as row_error, linked};
import nomo.session.work_chain_journal_contract.{CapturedJournal as Journal, invalid as journal_invalid};
import nomo.session.edit_operation.{selector_error, same_binding};

// Copied observations only; these values are never receipts or execution grants.
public type ObservedRow = { key: string, version: string, value: Record };
public type ObservedJournal = { key: string, version: string, value: Journal };
public type Snapshot = { root: Option<ObservedRow>, child: Option<ObservedRow>,
    root_journal: Option<ObservedJournal>, child_journal: Option<ObservedJournal> };
public enum Selector { All, Exact(string), Latest, Parent }

public flow journal_error(row: Record, journal: Option<Journal>) -> string {
    match journal {
        Some(value) => {
            let invalid = journal_invalid(value); if invalid != "" { return invalid; }
            if value.chain != row.chain || value.turn != row.turn || value.binding.id != row.id ||
                value.binding.workspace != row.workspace || value.binding.path != row.path { return "v2 discovery journal binding mismatch"; }
            match row.work {
                Some(work) => { if value.phase != "completed" || !same_binding(value.binding, work.binding) { return "v2 work and completed edit journal differ"; } }
                None() => {}
            }
        }
        None() => { if row.work != None() { return "v2 work has no confirmed edit journal"; } }
    }
    return "";
}
flow journal_row(row: Record, observed: Option<ObservedJournal>) -> string {
    let key = if row.turn == 1 { "turn:1" } else { "turn:2" };
    let selected = match observed {
        Some(value) => { if value.key != key { return "v2 discovery journal slot mismatch"; } Some(value.value) }
        None() => None(),
    };
    return journal_error(row, selected);
}
public flow validate(view: Snapshot, workspace: string, path: string) -> string {
    let binding = selector_error("discovery", workspace, path); if binding != "" { return binding; }
    let root = match view.root {
        Some(value) => value,
        None() => {
            if view.child != None() || view.root_journal != None() || view.child_journal != None() { return "v2 discovery orphan slot or journal"; }
            return "";
        }
    };
    let invalid = row_error(root.value); if invalid != "" { return invalid; }
    if root.value.format == 3 && (view.child != None() || view.child_journal != None()) { return "user-context work cannot have a successor or second journal"; }
    if root.key != "turn:1" || root.value.turn != 1 { return "v2 discovery root slot mismatch"; }
    if root.value.workspace != workspace || root.value.path != path { return "v2 discovery workspace or path mismatch"; }
    let root_edit = journal_row(root.value, view.root_journal); if root_edit != "" { return root_edit; }
    match view.child {
        Some(child) => {
            if child.key != "turn:2" || child.value.turn != 2 { return "v2 discovery child slot mismatch"; }
            let invalid = linked(root.value, root.version, child.value); if invalid != "" { return invalid; }
            let edit = journal_row(child.value, view.child_journal); if edit != "" { return edit; }
        }
        None() => { if view.child_journal != None() { return "v2 discovery orphan second journal; slot cannot be reused"; } }
    }
    return "";
}
public flow eligible(view: Snapshot, workspace: string, path: string) -> bool {
    if validate(view, workspace, path) != "" { return false; }
    return match view.root {
        Some(value) => value.value.format == 2 && value.value.phase == "summary-confirmed" && view.child == None() && view.child_journal == None(),
        None() => false,
    };
}
public flow select(view: Snapshot, workspace: string, path: string, selector: Selector) -> Result<Array<Record>, string> {
    let invalid = validate(view, workspace, path); if invalid != "" { return Err(invalid); }
    var rows: Array<Record> = [];
    match view.root { Some(value) => { rows = rows.push(value.value); } None() => {} }
    match view.child { Some(value) => { rows = rows.push(value.value); } None() => {} }
    return match selector {
        Selector.All => Ok(rows),
        Selector.Latest => if count(rows) == 0 { Ok([]) } else { Ok([rows[count(rows) - 1]]) },
        Selector.Exact(id) => {
            let error = selector_error(id, workspace, path); if error != "" { return Err(error); }
            if count(rows) == 0 { return Ok([]); }
            for row in rows limit Iterations(2) { if row.id == id { return Ok([row]); } }
            Err("v2 discovery selected ID missing")
        }
        Selector.Parent => if eligible(view, workspace, path) { Ok([rows[0]]) } else { Err("latest continuation requires a confirmed first turn and unused second slot; no fallback or replay") },
    };
}
public flow journal_phase(view: Snapshot, turn: i32) -> string {
    if turn != 1 && turn != 2 { return "invalid"; }
    let selected = if turn == 1 { view.root_journal } else { view.child_journal };
    return match selected { Some(value) => value.value.phase, None() => "missing" };
}


public flow consistent(before: Snapshot, after: Snapshot) -> string {
    return if before == after { "" } else { "v2 discovery changed during repeated reads; no selection or continuation" };
}
