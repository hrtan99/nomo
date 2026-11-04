module nomo.session.recoverable_work_facts;

import nomo.session.work_fact_events.{summary_source, selection};
import std.collections.len as count;
import std.memory.MemoryEntry;
import nomo.session.history_work_guard.Record;
import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.session.recoverable_check_store.Frame as CheckFrame;
import std.text.split;

import nomo.session.redaction.Policy;
import nomo.session.event_text_codec.decode;
import nomo.harness.history_continue_model.{WorkFacts, CheckOutput};
import nomo.session.recoverable_work_store.load as load_work;
import nomo.session.recoverable_check_store.load as load_check;
import nomo.session.recoverable_followup_store.load as load_followup;
import nomo.session.recoverable_followup_check_store.load as load_followup_check;
import nomo.session.edit_operation_store.{inspect as inspect_edit, available as edit_available};
import nomo.session.history_followup_edit_store.{inspect as inspect_followup_edit, available as followup_edit_available};
import nomo.session.continuous_work.{Entry, load as load_continuous};

public type Facts = { first: Option<WorkFacts>, followup: Option<WorkFacts>, additional: Array<WorkFacts>, calls: i32, generation: i32 };
flow extra_fact(item: Entry, policy: Policy) -> Result<WorkFacts, string> {
    if item.result.phase == "abandoned" && (item.check.phase == "none" || item.check.phase == "planned") { return Ok(WorkFacts { id = item.core.id, summary = "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.", summary_source = "system", selection = None(), check = "unknown", exit_code = "", output = None() }); }
    if item.result.phase != "complete" || (item.check.phase != "none" && item.check.phase != "complete" && item.check.phase != "abandoned") { return Err("continuous work unresolved"); }
    var output: Option<CheckOutput> = None();
    if item.check.phase == "complete" {
        output = Some(match check_values(item.check.stdout, item.check.stderr, item.check.stdout_truncated, item.check.stderr_truncated, policy) { Ok(value) => value, Err(error) => { return Err(error); } });
    }
    let chosen = match selection(item.result.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkFacts { id = item.core.id, summary = item.result.summary, summary_source = if (item.result.source == "model-v2" || item.result.source == "model-v3") { "model" } else { if (item.result.source == "system-v2" || item.result.source == "system-v3") { "system" } else { item.result.source } }, selection = chosen,
        check = if item.check.phase == "none" { "not requested" } else { if item.check.phase == "abandoned" { "abandoned; outcome unknown" } else { item.check.outcome } }, exit_code = item.check.exit_code, output = output });
}
// Keep older diagnostics at the original per-stream context bound; the stored
// excerpts remain intact and the two latest checks retain their wider context.
flow short_text(value: string) -> string {
    var result = ""; var size: usize = 0;
    for item in split(value, "") limit Iterations(262146) { if item != "" { if size < 128 { result = result + item; } size = size + 1; } }
    return result;
}
flow compact(value: WorkFacts) -> WorkFacts {
    let output = match value.output { None() => None(), Some(item) => {
        let out = short_text(item.stdout); let err = short_text(item.stderr);
        Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = item.stdout_truncated || out != item.stdout, stderr_truncated = item.stderr_truncated || err != item.stderr })
    } };
    return WorkFacts { id = value.id, summary = value.summary, summary_source = value.summary_source, selection = value.selection, check = value.check, exit_code = value.exit_code, output = output };
}
// Only completed recorded actions become untrusted model context. An uncertain
// edit or check is not retried and cannot be represented as a successful fact.
flow check_values(stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy) -> Result<CheckOutput, string> {
    let out = match decode(stdout, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let err = match decode(stderr, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    return Ok(CheckOutput { stdout = out, stderr = err, stdout_truncated = out_truncated, stderr_truncated = err_truncated });
}
flow completed_fact(work: Record, events: EventFrame, check: Option<MemoryEntry<string, CheckFrame>>, policy: Policy, label: string) -> Result<WorkFacts, string> {
    var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
    match check { Some(value) => {
        if value.value.check.phase == "abandoned" { outcome = "abandoned; outcome unknown"; } else {
        if value.value.check.phase != "complete" { return Err(label + " check unresolved"); }
        outcome = value.value.check.outcome; exit = value.value.check.exit_code;
        output = Some(match check_values(value.value.stdout, value.value.stderr, value.value.stdout_truncated, value.value.stderr_truncated, policy) { Ok(item) => item, Err(error) => { return Err(error); } }); }
    } None() => {} }
    let origin = match summary_source(events, work.summary, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let chosen = match selection(events.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkFacts { id = work.id, summary = work.summary, summary_source = origin, selection = chosen, check = outcome, exit_code = exit, output = output });
}
public flow snapshot(policy: Policy, binding: string) -> Result<Facts, string> {
    let first = match load_work(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let first_check = match load_check(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let followup = match load_followup(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let second_check = match load_followup_check(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    var first_facts: Option<WorkFacts> = None(); var second_facts: Option<WorkFacts> = None(); var calls: i32 = 0; var generation: i32 = 0;
    match first {
        None() => {
            match edit_available() { Ok(_) => {} Err(_) => { return Err("orphan first edit"); } }
            match first_check { Some(_) => { return Err("orphan first check"); } None() => {} }
        }
        Some(item) => {
            let work = item.value.work;
            if work.phase == "abandoned" {
                calls = work.reserved.calls; generation = work.reserved.generation;
                first_facts = Some(WorkFacts { id = work.id, summary = "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.", summary_source = "system", selection = None(), check = "unknown", exit_code = "", output = None() });
            } else {
            if work.phase != "complete" { return Err("first work unresolved"); }
            let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed first edit required"); } };
            if edit.phase != "completed" { return Err("first edit unresolved"); }
            let spent = match work.settled { Some(value) => value, None() => { return Err("first work budget missing"); } };
            calls = spent.read.calls + spent.edit.calls; generation = spent.read.tokens + spent.edit.tokens;
            first_facts = Some(match completed_fact(work, item.value.events, first_check, policy, "first") { Ok(value) => value, Err(error) => { return Err(error); } });
            }
        }
    }
    match followup {
        None() => {
            match followup_edit_available() { Ok(_) => {} Err(_) => { return Err("orphan followup edit"); } }
            match second_check { Some(_) => { return Err("orphan followup check"); } None() => {} }
        }
        Some(item) => {
            match first_facts { Some(_) => {} None() => { return Err("first work facts missing"); } }
            let work = item.value.work;
            if work.phase == "abandoned" {
                calls = calls + work.reserved.calls; generation = generation + work.reserved.generation;
                second_facts = Some(WorkFacts { id = work.id, summary = "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.", summary_source = "system", selection = None(), check = "unknown", exit_code = "", output = None() });
            } else {
            if work.phase != "complete" { return Err("followup unresolved"); }
            let edit = match inspect_followup_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed followup edit required"); } };
            if edit.phase != "completed" { return Err("followup edit unresolved"); }
            let spent = match work.settled { Some(value) => value, None() => { return Err("followup budget missing"); } };
            calls = calls + spent.read.calls + spent.edit.calls; generation = generation + spent.read.tokens + spent.edit.tokens;
            second_facts = Some(match completed_fact(work, item.value.events, second_check, policy, "followup") { Ok(value) => value, Err(error) => { return Err(error); } });
            }
        }
    }
    var additional: Array<WorkFacts> = [];
    let extra = match load_continuous(binding) { Ok(value) => value, Err(error) => { return Err(error); } };
    match extra { Some(value) => {
        match second_facts { None() => { return Err("followup facts missing"); } Some(_) => {} }
        let items = value.value.history.push(value.value.current);
        var index: usize = 0;
        for item in items limit Iterations(48) {
            let fact = match extra_fact(item, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
            additional = additional.push(if index + 2 < count(items) { compact(fact) } else { fact }); index = index + 1; calls = calls + if item.result.phase == "abandoned" { 7 } else { item.result.calls }; generation = generation + if item.result.phase == "abandoned" { if item.result.source == "wide-v3" { 188416 } else { if item.result.source == "wide" || item.result.source == "wide-v2" { 61440 } else { 51200 } } } else { item.result.generation };
        }
    } None() => {} }
    if count(additional) >= 1 { first_facts = match first_facts { Some(value) => Some(compact(value)), None() => None() }; }
    if count(additional) >= 2 { second_facts = match second_facts { Some(value) => Some(compact(value)), None() => None() }; }
    return Ok(Facts { first = first_facts, followup = second_facts, additional = additional, calls = calls, generation = generation });
}
