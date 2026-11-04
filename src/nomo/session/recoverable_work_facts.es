module nomo.session.recoverable_work_facts;

public import nomo.application.history_contract.Facts;
import nomo.application.history_contract.WorkFactsReader;
import nomo.session.work_fact_projection.{extra_fact, completed_fact, compact};

import std.collections.len as count;

import nomo.session.redaction.Policy;
import nomo.application.history_contract.WorkFacts;
import nomo.session.recoverable_work_store.load as load_work;
import nomo.application.check_contract.CheckFactsReader;
import nomo.session.check_lifecycle.{FirstCheck, FollowupCheck};
import nomo.session.recoverable_followup_store.load as load_followup;
import nomo.session.edit_operation_store.{inspect as inspect_edit, available as edit_available};
import nomo.session.history_followup_edit_store.{inspect as inspect_followup_edit, available as followup_edit_available};
import nomo.session.continuous_work.{load as load_continuous};

flow read_snapshot(policy: Policy, binding: string) -> Result<Facts, string> {
    let first = match load_work(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let first_reader = FirstCheck { redaction = policy, binding = binding };
    let first_check = match first_reader.read() { Ok(item) => item, Err(error) => { return Err(error); } };
    let followup = match load_followup(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let second_reader = FollowupCheck { redaction = policy, binding = binding };
    let second_check = match second_reader.read() { Ok(item) => item, Err(error) => { return Err(error); } };
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
            additional = additional.push(if index + 2 < count(items) { compact(fact) } else { fact }); index = index + 1; calls = calls + if item.result.phase == "abandoned" { 7 } else { item.result.calls }; generation = generation + if item.result.phase == "abandoned" { if item.result.source == "wide-v4" { 286720 } else { if item.result.source == "wide-v3" { 188416 } else { if item.result.source == "wide" || item.result.source == "wide-v2" { 61440 } else { 51200 } } } } else { item.result.generation };
        }
    } None() => {} }
    if count(additional) >= 1 { first_facts = match first_facts { Some(value) => Some(compact(value)), None() => None() }; }
    if count(additional) >= 2 { second_facts = match second_facts { Some(value) => Some(compact(value)), None() => None() }; }
    return Ok(Facts { first = first_facts, followup = second_facts, additional = additional, calls = calls, generation = generation });
}

public type EventWorkFacts = { redaction: Policy, binding: string };
impl EventWorkFacts ~ WorkFactsReader {
    flow snapshot(self) -> Result<Facts, string> { return read_snapshot(self.redaction, self.binding); }
}
public flow snapshot(policy: Policy, binding: string) -> Result<Facts, string> {
    let reader = EventWorkFacts { redaction = policy, binding = binding };
    return reader.snapshot();
}
