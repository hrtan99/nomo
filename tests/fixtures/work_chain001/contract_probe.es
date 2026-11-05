module app.contract_probe;

import std.io.println;
import std.text.char_count as len;
import nomo.session.work_chain.{Record, Caps, initial, initial_user_context, successor, validate, linked, publish_partial, confirm,
    maximum, turn_caps, zero, summary_reservation, values, reserve, policy, caps_error, fingerprint};
import nomo.session.work_record.Record as WorkRecord;
import nomo.session.work_record.partial;
import nomo.tools.edit_file.prepare_original;
import nomo.tools.edit_binding.bind;
import nomo.harness.harness_work_contract.Evidence;
import nomo.harness.harness_tool_contract.Ledger;

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
flow user_context_states() -> bool {
    let row = match initial_user_context("root-op", "owned", "target.txt", "update target from context", ["context.txt"], turn_caps()) { Ok(value) => value, Err(_) => { return false; } };
    let saved = match work("root-op", "old", "old", "blue") { Ok(value) => value, Err(_) => { return false; } };
    let pending = match publish_partial(row, saved) { Ok(value) => value, Err(_) => { return false; } };
    let completed = match confirm(pending, "first result") { Ok(value) => value, Err(_) => { return false; } };
    let parent = match first(true) { Ok(value) => value, Err(_) => { return false; } };
    let child = match second(parent, "blue", "blue") { Ok(value) => value, Err(_) => { return false; } };
    let refused = match successor(completed, "observed-opaque-version", "child-op", "update target from context", ["context.txt"], turn_caps()) { Ok(_) => false, Err(_) => true };
    let legacy_name = match initial("root-op", "user-context-once", "target.txt", "update target from context", ["context.txt"], turn_caps()) { Ok(value) => value, Err(_) => { return false; } };
    return row.format == 3 && pending.format == 3 && completed.format == 3 && validate(row) == "" && validate(pending) == "" && validate(completed) == "" &&
        refused && linked(completed, "observed-opaque-version", child) != "" && legacy_name.format == 2 && validate(legacy_name) == "";
}
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
flow checks() -> Array<Check> { return __CHECKS__; }
public flow pure_probe() -> bool { for item in checks() limit Iterations(32) { if !item.passed { return false; } } return true; }
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(32) { if !item.passed { println("FAIL " + item.label); abort("chain contract failed"); } println("PASS " + item.label); }
    return 0;
}
