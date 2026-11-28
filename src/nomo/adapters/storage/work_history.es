module nomo.adapters.storage.work_history;

import nomo.adapters.storage.chat.record_work_from;
import nomo.adapters.storage.check_lifecycle.{FirstCheck, FollowupCheck, load};
import nomo.adapters.storage.checks.inspect as checks_inspect;
import nomo.adapters.storage.edits.{
    edit_operation_store_available,
    edit_operation_store_inspect,
    history_followup_edit_store_available,
    history_followup_edit_store_inspect
};
import nomo.adapters.storage.followup.{inspect as followup_inspect, load as followup_load};
import nomo.adapters.storage.followup_checks.inspect as followup_checks_inspect;
import nomo.adapters.storage.work_admission.{
    chat_available,
    continuous_work_load,
    inspect,
    recoverable_work_store_load
};
import nomo.application.editing.ports.WorkTimeline;
import nomo.application.sessions.ports.WorkFactsReader;
import nomo.core.conversation.Event;
import nomo.domain.editing.Confirmed;
import nomo.domain.sessions.event_codec.Policy;
import nomo.domain.sessions.work.{
    CheckOutput,
    Facts,
    Pending,
    Summary,
    WorkFacts,
    abandoned_fact,
    capture,
    compact,
    completed_fact,
    extra_fact,
    settled_usage,
    stored_fact
};
import nomo.session.recoverable_chat_store.Frame;
import std.memory.MemoryEntry;

public type LegacyWorkFacts = {};

impl LegacyWorkFacts ~ WorkFactsReader {
    flow snapshot(self) -> Result<Facts, string> { return legacy_work_facts_read_snapshot(); }
}

flow legacy_work_facts_read_snapshot() -> Result<Facts, string> {
    var work_calls: i32 = 0; var work_generation: i32 = 0;
    let past_work = match inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
    var work_facts: Option<WorkFacts> = None();
    match past_work {
        None() => match chat_available() { Ok(_) => (), Err(error) => { return Err(error); } },
        Some(work) => {
            if work.phase != "complete" { return Err("work is not complete; inspect before continuing"); }
            let edit = match edit_operation_store_inspect(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed edit record required"); } };
            if edit.phase != "completed" { return Err("edit outcome unresolved"); }
            let check = match checks_inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
            var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
            match check {
                Some(value) => { if value.id != work.id { return Err("check work identity differs"); } if value.phase != "complete" { return Err("check outcome unresolved"); } outcome = value.outcome; exit = value.exit_code;
                    let saved = match load("first", value.id, value.digest) { Ok(item) => item, Err(error) => { return Err(error); } };
                    match saved { Some(item) => { output = Some(CheckOutput { stdout = item.stdout, stderr = item.stderr, stdout_truncated = item.stdout_truncated, stderr_truncated = item.stderr_truncated }); } None() => (), }
                }
                None() => (),
            }
            work_facts = Some(stored_fact(work.id, work.summary, "unknown", outcome, exit, output));
            let spent = match work.settled { Some(value) => value, None() => { return Err("first work ledger missing"); } };
            let usage = settled_usage(spent); work_calls = usage.calls; work_generation = usage.generation;
        }
    }
    let following = match followup_inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
    let following_check = match followup_checks_inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
    var followup_facts: Option<WorkFacts> = None();
    match following {
        None() => {
            match history_followup_edit_store_available() { Ok(_) => (), Err(error) => { return Err("orphan followup edit: " + error); } }
            match following_check { Some(_) => { return Err("orphan followup check"); } None() => (), }
        },
        Some(item) => {
            if item.phase != "complete" { return Err("followup work is unresolved"); }
            match work_facts { None() => { return Err("first work facts missing"); } Some(_) => (), }
            let edit = match history_followup_edit_store_inspect(item.id, item.workspace, item.path) { Ok(Some(value)) => value, _ => { return Err("completed followup edit required"); } };
            if edit.phase != "completed" { return Err("followup edit outcome unresolved"); }
            var outcome = "not requested"; var exit = ""; var output: Option<CheckOutput> = None();
            match following_check {
                Some(value) => { if value.id != item.id || value.phase != "complete" { return Err("followup check outcome unresolved"); } outcome = value.outcome; exit = value.exit_code;
                    let saved = match load("followup", value.id, value.digest) { Ok(found) => found, Err(error) => { return Err(error); } };
                    match saved { Some(found) => { output = Some(CheckOutput { stdout = found.stdout, stderr = found.stderr, stdout_truncated = found.stdout_truncated, stderr_truncated = found.stderr_truncated }); } None() => (), }
                }
                None() => (),
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

flow recoverable_work_facts_read_snapshot(policy: Policy, binding: string) -> Result<Facts, string> {
    let first = match recoverable_work_store_load(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let first_reader = FirstCheck { redaction = policy, binding };
    let first_check = match first_reader.read() { Ok(item) => item, Err(error) => { return Err(error); } };
    let followup = match followup_load(policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let second_reader = FollowupCheck { redaction = policy, binding };
    let second_check = match second_reader.read() { Ok(item) => item, Err(error) => { return Err(error); } };
    var first_facts: Option<WorkFacts> = None(); var second_facts: Option<WorkFacts> = None(); var calls: i32 = 0; var generation: i32 = 0;
    match first {
        None() => {
            match edit_operation_store_available() { Ok(_) => (), Err(_) => { return Err("orphan first edit"); } }
            match first_check { Some(_) => { return Err("orphan first check"); } None() => (), }
        },
        Some(item) => {
            let work = item.value.work;
            if work.phase == "abandoned" {
                calls = work.reserved.calls; generation = work.reserved.generation;
                first_facts = Some(abandoned_fact(work.id));
            } else {
            if work.phase != "complete" { return Err("first work unresolved"); }
            let edit = match edit_operation_store_inspect(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed first edit required"); } };
            if edit.phase != "completed" { return Err("first edit unresolved"); }
            let spent = match work.settled { Some(value) => value, None() => { return Err("first work budget missing"); } };
            let usage = settled_usage(spent); calls = usage.calls; generation = usage.generation;
            first_facts = Some(match completed_fact(work, item.value.events, first_check, policy, "first") { Ok(value) => value, Err(error) => { return Err(error); } });
            }
        }
    }
    match followup {
        None() => {
            match history_followup_edit_store_available() { Ok(_) => (), Err(_) => { return Err("orphan followup edit"); } }
            match second_check { Some(_) => { return Err("orphan followup check"); } None() => (), }
        },
        Some(item) => {
            match first_facts { Some(_) => (), None() => { return Err("first work facts missing"); } }
            let work = item.value.work;
            if work.phase == "abandoned" {
                calls = calls + work.reserved.calls; generation = generation + work.reserved.generation;
                second_facts = Some(abandoned_fact(work.id));
            } else {
            if work.phase != "complete" { return Err("followup unresolved"); }
            let edit = match history_followup_edit_store_inspect(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed followup edit required"); } };
            if edit.phase != "completed" { return Err("followup edit unresolved"); }
            let spent = match work.settled { Some(value) => value, None() => { return Err("followup budget missing"); } };
            let usage = settled_usage(spent); calls = calls + usage.calls; generation = generation + usage.generation;
            second_facts = Some(match completed_fact(work, item.value.events, second_check, policy, "followup") { Ok(value) => value, Err(error) => { return Err(error); } });
            }
        }
    }
    var additional: Array<WorkFacts> = [];
    let extra = match continuous_work_load(binding) { Ok(value) => value, Err(error) => { return Err(error); } };
    match extra { Some(value) => {
        match second_facts { None() => { return Err("followup facts missing"); } Some(_) => (), }
        let items = value.value.history.push(value.value.current);
        var index: usize = 0;
        @limits([Iterations(48)]) for item in items {
            let fact = match extra_fact(item, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
            additional = additional.push(if index + 2 < items.len() { compact(fact) } else { fact }); index = index + 1; calls = calls + if item.result.phase == "abandoned" { 7 } else { item.result.calls }; generation = generation + if item.result.phase == "abandoned" { if item.result.source == "wide-v5" || item.result.source == "wide-v4" { 286720 } else { if item.result.source == "high-input-v2" { 917504 } else { if item.result.source == "wide-v3" || item.result.source == "high-input-v1" { 188416 } else { if item.result.source == "wide" || item.result.source == "wide-v2" { 61440 } else { 51200 } } } } } else { item.result.generation };
        }
    } None() => (), }
    if additional.len() >= 1 { first_facts = match first_facts { Some(value) => Some(compact(value)), None() => None() }; }
    if additional.len() >= 2 { second_facts = match second_facts { Some(value) => Some(compact(value)), None() => None() }; }
    return Ok(Facts { first = first_facts, followup = second_facts, additional, calls, generation });
}

public type EventWorkFacts = { redaction: Policy, binding: string };

impl EventWorkFacts ~ WorkFactsReader {
    flow snapshot(self) -> Result<Facts, string> { return recoverable_work_facts_read_snapshot(self.redaction, self.binding); }
}

public flow snapshot(policy: Policy, binding: string) -> Result<Facts, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let reader = EventWorkFacts { redaction = policy, binding };
    return reader.snapshot();
}

public type LegacyWorkTimeline = {};

impl LegacyWorkTimeline ~ WorkTimeline {
    flow enabled(self) -> bool ![] { return false; }
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>] { return Err("legacy work has no event timeline"); }
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return Err("legacy work has no event timeline"); }
}

public type EventWorkTimeline = { chat: MemoryEntry<string, Frame> };

impl EventWorkTimeline ~ WorkTimeline {
    flow enabled(self) -> bool ![] { return true; }
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return capture(pending, confirmed, summary);
    }
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return record_work_from(self.chat, id, records, policy, binding);
    }
}
