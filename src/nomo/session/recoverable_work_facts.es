module nomo.session.recoverable_work_facts;

import nomo.session.redaction.Policy;
import nomo.session.event_text_codec.decode;
import nomo.harness.history_continue_model.{WorkFacts, CheckOutput};
import nomo.session.recoverable_work_store.load as load_work;
import nomo.session.recoverable_check_store.{Frame as CheckFrame, load as load_check};
import nomo.session.recoverable_followup_store.load as load_followup;
import nomo.session.recoverable_followup_check_store.load as load_followup_check;
import nomo.session.edit_operation_store.{inspect as inspect_edit, available as edit_available};
import nomo.session.history_followup_edit_store.{inspect as inspect_followup_edit, available as followup_edit_available};

public type Facts = { first: Option<WorkFacts>, followup: Option<WorkFacts>, calls: i32, generation: i32 };
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
            let work = item.value.work; if work.phase != "complete" { return Err("first work unresolved"); }
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
            first_facts = Some(WorkFacts { id = work.id, summary = work.summary, check = outcome, exit_code = exit, output = output });
        }
    }
    match followup {
        None() => {
            match followup_edit_available() { Ok(_) => {} Err(_) => { return Err("orphan followup edit"); } }
            match second_check { Some(_) => { return Err("orphan followup check"); } None() => {} }
        }
        Some(item) => {
            match first_facts { Some(_) => {} None() => { return Err("first work facts missing"); } }
            let work = item.value.work; if work.phase != "complete" { return Err("followup unresolved"); }
            let edit = match inspect_followup_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed followup edit required"); } };
            if edit.phase != "completed" { return Err("followup edit unresolved"); }
            let spent = match work.settled { Some(value) => value, None() => { return Err("followup budget missing"); } };
            calls = calls + spent.read.calls + spent.edit.calls; generation = generation + spent.read.tokens + spent.edit.tokens;
            var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
            match second_check { Some(value) => {
                if value.value.check.phase != "complete" { return Err("followup check unresolved"); }
                outcome = value.value.check.outcome; exit = value.value.check.exit_code;
                // The two check frames have identical structural fields.
                let out = match decode(value.value.stdout, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
                let err = match decode(value.value.stderr, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
                output = Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = value.value.stdout_truncated, stderr_truncated = value.value.stderr_truncated });
            } None() => {} }
            second_facts = Some(WorkFacts { id = work.id, summary = work.summary, check = outcome, exit_code = exit, output = output });
        }
    }
    return Ok(Facts { first = first_facts, followup = second_facts, calls = calls, generation = generation });
}
