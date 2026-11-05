module nomo.session.legacy_work_facts;

import nomo.application.history_contract.{WorkFacts, CheckOutput, Facts, WorkFactsReader};
import nomo.session.check_output.load as load_check_output;
import nomo.session.history_work_guard.{chat_available, inspect as inspect_work};
import nomo.session.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_check_guard.inspect as inspect_check;
import nomo.session.history_followup_guard.inspect as inspect_followup;
import nomo.session.history_followup_edit_store.{inspect as inspect_followup_edit, available as followup_edit_available};
import nomo.session.history_followup_check_guard.inspect as inspect_followup_check;
import nomo.session.work_fact_projection.{stored_fact, settled_usage};

public type LegacyWorkFacts = {};
impl LegacyWorkFacts ~ WorkFactsReader {
    flow snapshot(self) -> Result<Facts, string> { return read_snapshot(); }
}
flow read_snapshot() -> Result<Facts, string> {
    var work_calls: i32 = 0; var work_generation: i32 = 0;
    let past_work = match inspect_work() { Ok(value) => value, Err(error) => { return Err(error); } };
    var work_facts: Option<WorkFacts> = None();
    match past_work {
        None() => { match chat_available() { Ok(_) => {} Err(error) => { return Err(error); } } }
        Some(work) => {
            if work.phase != "complete" { return Err("work is not complete; inspect before continuing"); }
            let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed edit record required"); } };
            if edit.phase != "completed" { return Err("edit outcome unresolved"); }
            let check = match inspect_check() { Ok(value) => value, Err(error) => { return Err(error); } };
            var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
            match check {
                Some(value) => { if value.id != work.id { return Err("check work identity differs"); } if value.phase != "complete" { return Err("check outcome unresolved"); } outcome = value.outcome; exit = value.exit_code;
                    let saved = match load_check_output("first", value.id, value.digest) { Ok(item) => item, Err(error) => { return Err(error); } };
                    match saved { Some(item) => { output = Some(CheckOutput { stdout = item.stdout, stderr = item.stderr, stdout_truncated = item.stdout_truncated, stderr_truncated = item.stderr_truncated }); } None() => {} }
                }
                None() => {}
            }
            work_facts = Some(stored_fact(work.id, work.summary, "unknown", outcome, exit, output));
            let spent = match work.settled { Some(value) => value, None() => { return Err("first work ledger missing"); } };
            let usage = settled_usage(spent); work_calls = usage.calls; work_generation = usage.generation;
        }
    }
    let following = match inspect_followup() { Ok(value) => value, Err(error) => { return Err(error); } };
    let following_check = match inspect_followup_check() { Ok(value) => value, Err(error) => { return Err(error); } };
    var followup_facts: Option<WorkFacts> = None();
    match following {
        None() => {
            match followup_edit_available() { Ok(_) => {} Err(error) => { return Err("orphan followup edit: " + error); } }
            match following_check { Some(_) => { return Err("orphan followup check"); } None() => {} }
        }
        Some(item) => {
            if item.phase != "complete" { return Err("followup work is unresolved"); }
            match work_facts { None() => { return Err("first work facts missing"); } Some(_) => {} }
            let edit = match inspect_followup_edit(item.id, item.workspace, item.path) { Ok(Some(value)) => value, _ => { return Err("completed followup edit required"); } };
            if edit.phase != "completed" { return Err("followup edit outcome unresolved"); }
            var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
            match following_check {
                Some(value) => { if value.id != item.id || value.phase != "complete" { return Err("followup check outcome unresolved"); } outcome = value.outcome; exit = value.exit_code;
                    let saved = match load_check_output("followup", value.id, value.digest) { Ok(found) => found, Err(error) => { return Err(error); } };
                    match saved { Some(found) => { output = Some(CheckOutput { stdout = found.stdout, stderr = found.stderr, stdout_truncated = found.stdout_truncated, stderr_truncated = found.stderr_truncated }); } None() => {} }
                }
                None() => {}
            }
            let first = match item.parent.work.settled { Some(value) => value, None() => { return Err("first work ledger missing"); } };
            let second = match item.settled { Some(value) => value, None() => { return Err("followup ledger missing"); } };
            let first_usage = settled_usage(first); let second_usage = settled_usage(second);
            work_calls = first_usage.calls + second_usage.calls; work_generation = first_usage.generation + second_usage.generation;
            followup_facts = Some(stored_fact(item.id, item.summary, "unknown", outcome, exit, output));
        }
    }
    return Ok(Facts { first = work_facts, followup = followup_facts, additional = [], calls = work_calls, generation = work_generation });
}
