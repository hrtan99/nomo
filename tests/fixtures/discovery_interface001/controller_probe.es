module app.discovery_interface_probe;

import std.io.println;
import std.text.{len, split, to_string_i32};
import nomo.session.work_chain_discovery.{DiscoveryAuthority, discover as discover_controller, latest_parent as latest_controller};
import nomo.session.work_chain.{Record, Caps, initial, successor, validate, linked, publish_partial, confirm,
    maximum, turn_caps, zero, summary_reservation, values, reserve, policy, caps_error, fingerprint};
import nomo.session.work_record.Record as WorkRecord;
import nomo.session.work_record.partial;
import nomo.tools.edit_file.prepare_original;
import nomo.tools.edit_binding.bind;
import nomo.harness.harness_work_contract.Evidence;
import nomo.harness.harness_tool_contract.Ledger;


import nomo.session.work_chain_selection.{Snapshot, ObservedRow, ObservedJournal, Selector, select as choose, validate as selection_error, eligible, journal_phase};
import nomo.session.work_chain_journal_contract.CapturedJournal as Journal;
import nomo.session.work_chain_observation.{SessionObservation, ObservationPass, observe as observe_sessions};
import nomo.cli.work_chain_selection_args.{Command, parse as selection_args};
import nomo.cli.terminal_args.{parse as startup, parse_once, bind_parent, work_arguments, show_arguments};

type Check = { label: string, passed: bool };
flow from_values(value: Array<i32>) -> Caps {
    return Caps { steps = value[0], calls = value[1], generation = value[2], native_tokens = value[3], read_tools = value[4],
        scan = value[5], edit_reads = value[6], edit_read_bytes = value[7], atomic = value[8], atomic_bytes = value[9] };
}
flow changed_caps(value: Caps, selected: usize, difference: i32) -> Caps {
    let fields = values(value); var result: Array<i32> = []; var index: usize = 0;
    while index < 10 limit Iterations(10) { result = result.push(fields[index] + if index == selected { difference } else { 0 }); index = index + 1; }
    return from_values(result);
}
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
flow second(parent: Record, before: string, target: string) -> Result<Record, string> {
    let row = match successor(parent, "observed-opaque-version", "child-op", "update target from context", ["context.txt"], turn_caps()) {
        Ok(value) => value, Err(error) => { return Err(error); } };
    let saved = match work("child-op", before, target, "green") { Ok(value) => value, Err(error) => { return Err(error); } };
    let pending = match publish_partial(row, saved) { Ok(value) => value, Err(error) => { return Err(error); } };
    return confirm(pending, "second result");
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
flow declared_lifetime() -> bool {
    let row = match admitted() { Ok(value) => value, Err(_) => { return false; } };
    return row.format == 2 && row.phase == "admitted" && row.turn == 1 && row.id == row.chain && row.work == None() &&
        values(row.maximum) == [26,14,94208,393216,2,8192,6,12288,2,4096] &&
        values(row.available) == [13,7,47104,196608,1,4096,3,6144,1,2048] && row.remaining == turn_caps() && row.reserved == turn_caps();
}
flow conservation() -> bool {
    let start = match admitted() { Ok(value) => value, Err(_) => { return false; } };
    let pending = match first(false) { Ok(value) => value, Err(_) => { return false; } };
    let parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    let next = match successor(parent, "observed-opaque-version", "child-op", "update target from context", ["context.txt"], turn_caps()) {
        Ok(value) => value, Err(_) => { return false; } };
    let child = match second(parent, "blue", "blue") { Ok(value) => value, Err(_) => { return false; } };
    return start.remaining == pending.remaining && pending.remaining == parent.remaining && parent.remaining == turn_caps() &&
        pending.reserved == summary_reservation() && parent.reserved == zero() && next.remaining == zero() && next.reserved == turn_caps() &&
        child.remaining == zero() && child.reserved == zero() && validate(parent) == "" && validate(child) == "" &&
        linked(parent, "observed-opaque-version", child) == "";
}
flow opaque_fingerprint() -> bool {
    let parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    let first = match fingerprint(parent) { Ok(value) => value, Err(_) => { return false; } };
    let child = match successor(parent, "observed-opaque-version", "child-op", "update target from context", ["context.txt"], turn_caps()) {
        Ok(value) => value, Err(_) => { return false; } };
    return len(first) == 64 && child.parent_digest == first && child.parent_version == "observed-opaque-version" &&
        linked(parent, "other-opaque-version", child) != "" && linked(parent, "observed-opaque-version", child) == "";
}
flow shortage(axis: usize, saved: bool) -> bool {
    let lower = changed_caps(turn_caps(), axis, -1);
    let result = if saved { reserve(lower, turn_caps()) } else { reserve(maximum(), lower) };
    return match result { Ok(_) => false, Err(_) => true };
}
flow over_policy(axis: usize) -> bool {
    return match reserve(maximum(), changed_caps(turn_caps(), axis, 1)) { Ok(_) => false, Err(_) => true };
}
flow parse(raw: string, accepted: bool) -> bool { return match policy(raw) { Ok(_) => accepted, Err(_) => !accepted }; }
flow parent_refused(mode: string) -> bool {
    var parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    if mode == "admitted" { parent = match admitted() { Ok(value) => value, Err(_) => { return false; } }; }
    else if mode == "partial" { parent = match first(false) { Ok(value) => value, Err(_) => { return false; } }; }
    else if mode == "third" { parent = match second(parent, "blue", "blue") { Ok(value) => value, Err(_) => { return false; } }; }
    else { parent = patched(parent, mode); }
    return match successor(parent, "observed-opaque-version", "new-op", "update target from context", ["context.txt"], turn_caps()) { Ok(_) => false, Err(_) => true };
}
flow repeated_id() -> bool {
    let parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    return match successor(parent, "observed-opaque-version", "root-op", "update target from context", ["context.txt"], turn_caps()) { Ok(_) => false, Err(_) => true };
}
flow corrupt(mode: string) -> bool {
    let row = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    return validate(patched(row, mode)) != "";
}
flow child_corrupt(mode: string) -> bool {
    let parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    let child = match second(parent, "blue", "blue") { Ok(value) => value, Err(_) => { return false; } };
    return linked(parent, "observed-opaque-version", patched(child, mode)) != "";
}
flow original_changed() -> bool {
    let parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    let child = match second(parent, "different", "different") { Ok(value) => value, Err(_) => { return false; } };
    return validate(child) == "" && linked(parent, "observed-opaque-version", child) != "";
}
flow token_bound(token: string, accepted: bool) -> bool {
    let parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    return match successor(parent, token, "child-op", "update target from context", ["context.txt"], turn_caps()) { Ok(_) => accepted, Err(_) => !accepted };
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
            value = if mode == "lineage" || mode == "child_value" { patched(value.value, if mode == "lineage" { "parent_version" } else { "format" }) } else { value.value } }),
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
        Some(value) => Some(ObservedJournal { key = value.key, version = if mode == "child_journal_version" { "changed-version" } else { value.version },
            value = Journal { format = value.value.format, chain = if mode == "child_journal_chain" { "foreign" } else { value.value.chain }, turn = value.value.turn, phase = value.value.phase, binding = value.value.binding } }),
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

flow selector(value: string) -> Selector {
    return match value { "all" => Selector.All, "latest" => Selector.Latest, "parent" => Selector.Parent, _ => Selector.Exact(value) };
}
flow discover_case(label: string, kind: string, requested: string, authority: string, fail_at: i32, drift_at: i32, difference: string, workspace: string, expected_error: string) -> bool {
    let view = match frame(kind) { Ok(value) => value, Err(_) => { return false; } };
    var captures: i32 = 0;
    let result = discover_controller(workspace, "target.txt", selector(requested)) with { 
        SessionObservation.capture(pass) => {
            captures = captures + 1;
            let phase = match pass { ObservationPass.First => "first", ObservationPass.Recheck => "recheck" };
            println("PORT " + label + " capture " + to_string_i32(captures) + " " + phase);
            let selected = if captures == drift_at { changed(view, difference) } else { view };
            let answer: Result<Snapshot, string> = if captures == fail_at { Err("capture refused") } else { Ok(selected) };
            resume answer;
        }
        DiscoveryAuthority.inspect(id, workspace, path) => {
            println("PORT " + label + " inspect " + id);
            if workspace != "owned" || path != "target.txt" { abort("incorrect authority binding"); }
            let rows = match choose(view, workspace, path, Selector.Exact(id)) { Ok(value) => value, Err(_) => { abort("unexpected inspect"); } };
            var answer: Result<Option<Record>, string> = Ok(Some(rows[0]));
            if authority == "error" || (authority == "second_error" && id == "child-op") { answer = Err("inspect refused"); }
            else if authority == "missing" { answer = Ok(None()); }
            else if authority == "row" || (authority == "second_row" && id == "child-op") { answer = Ok(Some(patched(rows[0], "parent_id"))); }
            resume answer;
        }
        DiscoveryAuthority.confirmed_parent(id, workspace, path) => {
            println("PORT " + label + " parent " + id);
            if id != "root-op" || workspace != "owned" || path != "target.txt" { abort("incorrect parent binding"); }
            let root = match view.root { Some(value) => value, None() => { abort("unexpected parent"); } };
            let altered = ObservedRow { key = if authority == "key" { "wrong" } else { root.key },
                version = if authority == "version" { "wrong" } else { root.version },
                value = if authority == "row" { patched(root.value, "parent_id") } else { root.value } };
            let answer: Result<ObservedRow, string> = if authority == "error" { Err("parent refused") } else { Ok(altered) };
            resume answer;
        }
 };
    return match result { Ok(value) => expected_error == "" && value == view, Err(error) => error == expected_error };
}
flow parent_case(label: string, kind: string, authority: string, fail_at: i32, drift_at: i32, difference: string, workspace: string, expected_error: string) -> bool {
    let view = match frame(kind) { Ok(value) => value, Err(_) => { return false; } };
    var captures: i32 = 0;
    let result = latest_controller(workspace, "target.txt") with { 
        SessionObservation.capture(pass) => {
            captures = captures + 1;
            let phase = match pass { ObservationPass.First => "first", ObservationPass.Recheck => "recheck" };
            println("PORT " + label + " capture " + to_string_i32(captures) + " " + phase);
            let selected = if captures == drift_at { changed(view, difference) } else { view };
            let answer: Result<Snapshot, string> = if captures == fail_at { Err("capture refused") } else { Ok(selected) };
            resume answer;
        }
        DiscoveryAuthority.inspect(id, workspace, path) => {
            println("PORT " + label + " inspect " + id);
            if workspace != "owned" || path != "target.txt" { abort("incorrect authority binding"); }
            let rows = match choose(view, workspace, path, Selector.Exact(id)) { Ok(value) => value, Err(_) => { abort("unexpected inspect"); } };
            var answer: Result<Option<Record>, string> = Ok(Some(rows[0]));
            if authority == "error" || (authority == "second_error" && id == "child-op") { answer = Err("inspect refused"); }
            else if authority == "missing" { answer = Ok(None()); }
            else if authority == "row" || (authority == "second_row" && id == "child-op") { answer = Ok(Some(patched(rows[0], "parent_id"))); }
            resume answer;
        }
        DiscoveryAuthority.confirmed_parent(id, workspace, path) => {
            println("PORT " + label + " parent " + id);
            if id != "root-op" || workspace != "owned" || path != "target.txt" { abort("incorrect parent binding"); }
            let root = match view.root { Some(value) => value, None() => { abort("unexpected parent"); } };
            let altered = ObservedRow { key = if authority == "key" { "wrong" } else { root.key },
                version = if authority == "version" { "wrong" } else { root.version },
                value = if authority == "row" { patched(root.value, "parent_id") } else { root.value } };
            let answer: Result<ObservedRow, string> = if authority == "error" { Err("parent refused") } else { Ok(altered) };
            resume answer;
        }
 };
    return match result { Ok(value) => expected_error == "" && value == "root-op", Err(error) => error == expected_error };
}
public flow discovery_unhandled() -> bool { return match discover_controller("owned", "target.txt", Selector.All) { Ok(_) => true, Err(_) => false }; }
public flow latest_unhandled() -> bool { return match latest_controller("owned", "target.txt") { Ok(_) => true, Err(_) => false }; }
public flow exercise(args: Array<string>) -> i32 {
    let checks: Array<Check> = [__CHECKS__];
    for item in checks limit Iterations(80) {
        if !item.passed { println("FAIL " + item.label); abort("discovery interface failure"); }
        println("PASS " + item.label);
    }
    return 0;
}
