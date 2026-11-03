module nomo.session.recoverable_work_facts;

import nomo.session.work_fact_events.{summary_source, selection};

import nomo.session.redaction.Policy;
import nomo.session.event_text_codec.decode;
import nomo.harness.history_continue_model.{WorkFacts, CheckOutput};
import nomo.session.recoverable_work_store.load as load_work;
import nomo.session.recoverable_check_store.{Frame as CheckFrame, load as load_check};
import nomo.session.recoverable_followup_store.load as load_followup;
import nomo.session.recoverable_followup_check_store.load as load_followup_check;
import nomo.session.edit_operation_store.{inspect as inspect_edit, available as edit_available};
import nomo.session.history_followup_edit_store.{inspect as inspect_followup_edit, available as followup_edit_available};
import nomo.session.continuous_work.{Entry, load as load_continuous};

public type Facts = { first: Option<WorkFacts>, followup: Option<WorkFacts>, additional: Array<WorkFacts>, calls: i32, generation: i32 };
flow extra_fact(item: Entry, policy: Policy) -> Result<WorkFacts, string> {
    if item.result.phase == "abandoned" && (item.check.phase == "none" || item.check.phase == "planned") { return Ok(WorkFacts { id = item.core.id, summary = "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.", summary_source = "system", selection = None(), check = "unknown", exit_code = "", output = None() }); }
    if item.result.phase != "complete" || (item.check.phase != "none" && item.check.phase != "complete") { return Err("continuous work unresolved"); }
    var output: Option<CheckOutput> = None();
    if item.check.phase == "complete" {
        let out = match decode(item.check.stdout, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
        let err = match decode(item.check.stderr, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
        output = Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = item.check.stdout_truncated, stderr_truncated = item.check.stderr_truncated });
    }
    let chosen = match selection(item.result.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(WorkFacts { id = item.core.id, summary = item.result.summary, summary_source = item.result.source, selection = chosen,
        check = if item.check.phase == "none" { "not requested" } else { item.check.outcome }, exit_code = item.check.exit_code, output = output });
}
// Only completed recorded actions become untrusted model context. An uncertain
// edit or check is not retried and cannot be represented as a successful fact.
flow check_values(value: Option<CheckFrame>, policy: Policy) -> Result<CheckOutput, string> {
    let record = match value { Some(item) => item, None() => { return Err("check output unavailable"); } };
    let out = match decode(record.stdout, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let err = match decode(record.stderr, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    return Ok(CheckOutput { stdout = out, stderr = err, stdout_truncated = record.stdout_truncated, stderr_truncated = record.stderr_truncated });
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
            var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
            match first_check { Some(value) => {
                if value.value.check.phase != "complete" { return Err("first check unresolved"); }
                outcome = value.value.check.outcome; exit = value.value.check.exit_code;
                output = Some(match check_values(Some(value.value), policy) { Ok(item) => item, Err(error) => { return Err(error); } });
            } None() => {} }
            let origin = match summary_source(item.value.events, work.summary, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
            let chosen = match selection(item.value.events.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
            first_facts = Some(WorkFacts { id = work.id, summary = work.summary, summary_source = origin, selection = chosen, check = outcome, exit_code = exit, output = output });
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
            var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
            match second_check { Some(value) => {
                if value.value.check.phase != "complete" { return Err("followup check unresolved"); }
                outcome = value.value.check.outcome; exit = value.value.check.exit_code;
                let out = match decode(value.value.stdout, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
                let err = match decode(value.value.stderr, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
                output = Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = value.value.stdout_truncated, stderr_truncated = value.value.stderr_truncated });
            } None() => {} }
            let origin = match summary_source(item.value.events, work.summary, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
            let chosen = match selection(item.value.events.events, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
            second_facts = Some(WorkFacts { id = work.id, summary = work.summary, summary_source = origin, selection = chosen, check = outcome, exit_code = exit, output = output });
            }
        }
    }
    var additional: Array<WorkFacts> = [];
    let extra = match load_continuous(binding) { Ok(value) => value, Err(error) => { return Err(error); } };
    match extra { Some(value) => {
        match second_facts { None() => { return Err("followup facts missing"); } Some(_) => {} }
        let items = value.value.history.push(value.value.current);
        for item in items limit Iterations(32) {
            let fact = match extra_fact(item, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
            additional = additional.push(fact); calls = calls + if item.result.phase == "abandoned" { 7 } else { item.result.calls }; generation = generation + if item.result.phase == "abandoned" { 51200 } else { item.result.generation };
        }
    } None() => {} }
    return Ok(Facts { first = first_facts, followup = second_facts, additional = additional, calls = calls, generation = generation });
}
