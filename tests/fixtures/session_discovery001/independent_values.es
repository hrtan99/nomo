module app.contract_probe;

import std.io.println;
import std.text.{len, split};
import nomo.session.work_chain.{Record, Caps, initial, successor, validate, linked, publish_partial, confirm,
    maximum, turn_caps, zero, summary_reservation, values, reserve, policy, caps_error, fingerprint};
import nomo.session.work_record.Record as WorkRecord;
import nomo.session.work_record.partial;
import nomo.tools.edit_file.prepare_original;
import nomo.tools.edit_binding.bind;
import nomo.harness.harness_work_contract.Evidence;
import nomo.harness.harness_tool_contract.Ledger;


import nomo.session.work_chain_selection.{Snapshot, ObservedRow, ObservedJournal, Selector, select as choose, validate as selection_error, eligible, journal_phase, consistent};
import nomo.session.work_chain_journal_contract.CapturedJournal as Journal;
import nomo.cli.work_chain_selection_args.{Command, parse as selection_args};
import nomo.cli.terminal_args.{parse as startup, parse_once, bind_parent, work_arguments, show_arguments};

type Check = { label: string, passed: bool };
flow admitted() -> Result<Record, string> { return initial("root-op", "owned", "target.txt", "update target from context", ["context.txt"], turn_caps()); }
flow work(id: string, before: string, target: string, replacement: string) -> Result<WorkRecord, string> {
    let prepared = match prepare_original("target.txt", before, target, replacement) { Ok(value) => value, Err(error) => { return Err(error); } };
    let binding = match bind(id, "owned", "target.txt", prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    let evidence = Evidence { request = "update target from context", task = "Read context.txt", operation = "read", files = ["context.txt"],
        literal = "", outcome = "complete: blue", result = "Seen: complete: blue", summary = "Use the context result", allowed = ["context.txt"],
        ledger = Ledger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 } };
    return partial(binding, evidence, "replace selected text", prepared);
}
flow first(completed: bool) -> Result<Record, string> {
    let row = match admitted() { Ok(value) => value, Err(error) => { return Err(error); } };
    let saved = match work("root-op", "old", "old", "blue") { Ok(value) => value, Err(error) => { return Err(error); } };
    let pending = match publish_partial(row, saved) { Ok(value) => value, Err(error) => { return Err(error); } };
    if completed { return confirm(pending, "first result"); }
    return Ok(pending);
}
flow patched(row: Record, mode: string) -> Record {
    return Record { format = if mode == "format" { 1 } else { row.format }, phase = if mode == "phase" { "unknown" } else { row.phase },
        chain = if mode == "chain" { "wrong-chain" } else { row.chain }, turn = if mode == "turn" { 3 } else { row.turn },
        id = row.id, workspace = if mode == "workspace" { "wrong" } else { row.workspace },
        region = if mode == "region" { "wrong" } else { row.region }, path = if mode == "path" { "other.txt" } else { row.path },
        request = if mode == "request" { "wrong" } else { row.request }, allowed = if mode == "allowed" { ["other.txt"] } else { row.allowed },
        parent_id = if mode == "parent_id" { "wrong" } else { row.parent_id },
        parent_version = if mode == "parent_version" { "wrong" } else { row.parent_version },
        parent_digest = if mode == "parent_digest" { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } else { row.parent_digest },
        maximum = if mode == "maximum" { turn_caps() } else { row.maximum }, available = if mode == "available" { maximum() } else { row.available },
        remaining = if mode == "remaining" { maximum() } else { row.remaining },
        reserved = if mode == "reserved" { turn_caps() } else { row.reserved }, work = if mode == "work" { None() } else { row.work } };
}
flow slash() -> string { return split("\\/", "")[1]; }
flow copied_journal(row: Record, phase: string) -> Result<Journal, string> {
    let captured = match row.work {
        Some(value) => value,
        None() => match work(row.id, if row.turn == 1 { "old" } else { "blue" }, if row.turn == 1 { "old" } else { "blue" }, if row.turn == 1 { "blue" } else { "green" }) {
            Ok(value) => value, Err(error) => { return Err(error); }
        },
    };
    return Ok(Journal { format = 2, chain = row.chain, turn = row.turn, phase = phase, binding = captured.binding });
}
flow frame(kind: string) -> Result<Snapshot, string> {
    if kind == "empty" { return Ok(Snapshot { root = None(), child = None(), root_journal = None(), child_journal = None() }); }
    var parent = match first(true) { Ok(value) => value, Err(error) => { return Err(error); } };
    if kind == "admitted" || kind == "admitted_intent" { parent = match admitted() { Ok(value) => value, Err(error) => { return Err(error); } }; }
    if kind == "partial" { parent = match first(false) { Ok(value) => value, Err(error) => { return Err(error); } }; }
    var child: Option<ObservedRow> = None(); var child_edit: Option<ObservedJournal> = None();
    if kind == "child_admitted" || kind == "child_partial" || kind == "child_confirmed" {
        var row = match successor(parent, "observed-opaque-version", "child-op", "update target from context", ["context.txt"], turn_caps()) { Ok(value) => value, Err(error) => { return Err(error); } };
        if kind != "child_admitted" {
            let captured = match work("child-op", "blue", "blue", "green") { Ok(value) => value, Err(error) => { return Err(error); } };
            row = match publish_partial(row, captured) { Ok(value) => value, Err(error) => { return Err(error); } };
            if kind == "child_confirmed" { row = match confirm(row, "second result") { Ok(value) => value, Err(error) => { return Err(error); } }; }
            let journal = match copied_journal(row, "completed") { Ok(value) => value, Err(error) => { return Err(error); } };
            child_edit = Some(ObservedJournal { key = "turn:2", version = "child-journal-version", value = journal });
        }
        child = Some(ObservedRow { key = "turn:2", version = "child-version", value = row });
    }
    var root_edit: Option<ObservedJournal> = None();
    if parent.work != None() || kind == "admitted_intent" {
        let journal = match copied_journal(parent, if kind == "admitted_intent" { "intent" } else { "completed" }) { Ok(value) => value, Err(error) => { return Err(error); } };
        root_edit = Some(ObservedJournal { key = "turn:1", version = "root-journal-version", value = journal });
    }
    return Ok(Snapshot { root = Some(ObservedRow { key = "turn:1", version = "observed-opaque-version", value = parent }),
        child = child, root_journal = root_edit, child_journal = child_edit });
}
flow changed(view: Snapshot, mode: string) -> Snapshot {
    let root = match view.root {
        Some(value) => Some(ObservedRow { key = if mode == "root_key" { "turn:2" } else { value.key },
            version = if mode == "root_version" { "changed-version" } else { value.version },
            value = if mode == "root_value" { patched(value.value, "format") } else { value.value } }),
        None() => None(),
    };
    let child = match view.child {
        Some(value) => Some(ObservedRow { key = if mode == "child_key" { "turn:1" } else { value.key },
            version = if mode == "child_version" { "changed-version" } else { value.version },
            value = if mode == "lineage" { patched(value.value, "parent_version") } else { value.value } }),
        None() => None(),
    };
    let edit = match view.root_journal {
        Some(value) => Some(ObservedJournal { key = if mode == "journal_key" { "turn:2" } else { value.key },
            version = if mode == "journal_version" { "changed-version" } else { value.version },
            value = Journal { format = if mode == "journal_format" { 1 } else { value.value.format },
                chain = if mode == "journal_chain" { "foreign" } else { value.value.chain }, turn = value.value.turn,
                phase = if mode == "journal_phase" { "intent" } else { value.value.phase }, binding = value.value.binding } }),
        None() => None(),
    };
    let child_edit = match view.child_journal {
        Some(value) => Some(ObservedJournal { key = value.key, version = if mode == "child_journal_version" { "changed-version" } else { value.version }, value = value.value }),
        None() => None(),
    };
    var selected_child_edit: Option<ObservedJournal> = child_edit;
    if mode == "orphan_second_journal" { selected_child_edit = edit; }
    if mode == "child_journal_absent" { selected_child_edit = None(); }
    return Snapshot { root = if mode == "root_absent" { None() } else { root }, child = if mode == "child_absent" { None() } else { child },
        root_journal = if mode == "journal_absent" { None() } else { edit },
        child_journal = selected_child_edit };
}
flow selected(kind: string, requested: string, expected: Array<string>) -> bool {
    let view = match frame(kind) { Ok(value) => value, Err(_) => { return false; } };
    let selector = match requested { "all" => Selector.All, "latest" => Selector.Latest, "parent" => Selector.Parent, _ => Selector.Exact(requested) };
    let rows = match choose(view, "owned", "target.txt", selector) { Ok(value) => value, Err(_) => { return false; } };
    var ids: Array<string> = []; for row in rows limit Iterations(2) { ids = ids.push(row.id); }
    return ids == expected;
}
flow selection_refused(kind: string, requested: string) -> bool {
    let view = match frame(kind) { Ok(value) => value, Err(_) => { return false; } };
    return match choose(view, "owned", "target.txt", if requested == "parent" { Selector.Parent } else { Selector.Exact(requested) }) { Ok(_) => false, Err(_) => true };
}
flow latest_metadata(kind: string, phase: string, journal: string, can_continue: bool) -> bool {
    let view = match frame(kind) { Ok(value) => value, Err(_) => { return false; } };
    let rows = match choose(view, "owned", "target.txt", Selector.Latest) { Ok(value) => value, Err(_) => { return false; } };
    return rows[0].phase == phase && journal_phase(view, rows[0].turn) == journal && eligible(view, "owned", "target.txt") == can_continue;
}
flow invalid_graph(kind: string, mode: string) -> bool {
    let view = match frame(kind) { Ok(value) => changed(value, mode), Err(_) => { return false; } };
    return selection_error(view, "owned", "target.txt") != "" && !eligible(view, "owned", "target.txt") &&
        match choose(view, "owned", "target.txt", Selector.Latest) { Ok(_) => false, Err(_) => true };
}
flow binding_refused(workspace: string, path: string) -> bool {
    let value = match frame("confirmed") { Ok(value) => value, Err(_) => { return false; } };
    return match choose(value, workspace, path, Selector.Latest) { Ok(_) => false, Err(_) => true };
}
flow parsed(args: Array<string>, listing: bool, expected: string) -> bool {
    let result = selection_args(args, if listing { Command.Sessions } else { Command.Show });
    return match result {
        Err(_) => expected == "refused",
        Ok(value) => {
            if value.help { return expected == "help"; }
            let chosen = match value.selector {
                Selector.All => expected == "all", Selector.Latest => expected == "latest",
                Selector.Exact(id) => expected == id, Selector.Parent => false,
            };
            chosen && value.workspace == "owned" && value.path == "target.txt"
        },
    };
}
flow terminal_parsed(args: Array<string>, latest: bool) -> bool {
    return match startup(args) { Ok(value) => value.latest == latest, Err(_) => false };
}
flow terminal_refused(args: Array<string>) -> bool { return match startup(args) { Ok(_) => false, Err(_) => true }; }
flow latest_bound(args: Array<string>, parent: string, expected: Array<string>) -> bool {
    let input = match startup(args) { Ok(value) => value, Err(_) => { return false; } };
    if !input.latest || input.root_id != "" || input.parent != "" { return false; }
    match work_arguments(input, 2, "replace selected literal") { Ok(_) => { return false; } Err(_) => {} }
    match show_arguments(input, 1) { Ok(_) => { return false; } Err(_) => {} }
    let selected = match bind_parent(input, parent) { Ok(value) => value, Err(_) => { return false; } };
    return !selected.latest && selected.parent == parent && selected.root_id == parent &&
        match work_arguments(selected, 2, "replace selected literal") { Ok(value) => value == expected, Err(_) => false };
}
flow latest_bind_refused(args: Array<string>, parent: string) -> bool {
    let input = match startup(args) { Ok(value) => value, Err(_) => { return false; } };
    return match bind_parent(input, parent) { Ok(_) => false, Err(_) => true };
}
flow once_missing(args: Array<string>) -> bool { return match parse_once(args) { Ok(_) => false, Err(_) => true }; }

// Plain value comparison only; this never calls the observation controller.
flow copied_comparison(kind: string, mode: string, same: bool) -> bool {
    let before = match frame(kind) { Ok(value) => value, Err(_) => { return false; } };
    let after = changed(before, mode);
    return (consistent(before, after) == "") == same;
}
flow copied_empty_presence() -> bool {
    let before = match frame("empty") { Ok(value) => value, Err(_) => { return false; } };
    let after = match frame("confirmed") { Ok(value) => value, Err(_) => { return false; } };
    return consistent(before, after) != "";
}
flow checks() -> Array<Check> { return __CHECKS__; }
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(32) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(32) {
        if !item.passed { println("FAIL " + item.label); abort("independent discovery value contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
