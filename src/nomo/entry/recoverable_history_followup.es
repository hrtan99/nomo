module nomo.entry.recoverable_history_followup;

import nomo.session.work_fact_events.{summary_source, selection};
import nomo.session.recoverable_work_facts.snapshot as work_snapshot;
import nomo.harness.history_continue_model.WorkFacts;

import std.io.println;
import std.collections.len as count;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.{Work, parse_recorded};
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.read_model_tools.{expanded_work_child_turn as work_child_turn};
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.history_followup_model.{plan, child, large_child, aggregate, read_main_mode, wide_plan, wide_aggregate, PriorWork, HistoryWork};
import nomo.harness.history_continue_model.CheckOutput;
import nomo.session.event_policy.{PolicyRoot, load as load_policy};
import nomo.session.recoverable_check_store.load as inspect_first_check;
import nomo.session.recoverable_work_store.load as inspect_first_work;
import nomo.session.event_text_codec.decode;

import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.entry.harness_work_entry.{prepare_expanded_unicode, finish_edit, finish_history_summary, expanded_ledger as ledger, expanded_stage as stage, simple_refused as refused, Pending, Failure, Completed, Summary};
import nomo.session.recoverable_chat_store.{load as load_chat, record_work};
import nomo.session.recoverable_followup_store.{admit, claim, finish, abandon as abandon_followup};
import nomo.session.recoverable_followup_store.load as load_followup;
import nomo.session.continuous_work.{load as load_extra, admit as admit_extra, edit_intent, edit_complete, finish as finish_extra, abandon as abandon_extra, abandon_check as abandon_extra_check};
import nomo.session.redaction.Policy;
import nomo.session.recoverable_followup_check_store.{plan as plan_check, load as load_followup_check, abandon as abandon_followup_check};
import nomo.session.work_fact_events.capture;
import nomo.session.history_followup_edit_store.{available, begin, complete};
import nomo.entry.edit_coordinator.{Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, apply_wide as apply};

flow prepare_history(input: Work, prior_request: string, previous: Previous, prior_work: PriorWork, wide: bool) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => stage(name, state, wide);
    return prepare_expanded_unicode(input, original, log, wide) with {
        LegacyStringStages.main(value) => { resume read_main_mode(value, prior_request, previous, prior_work, wide); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected, wide); }
        LegacyEditStages.plan(value) => { resume if wide { wide_plan(value, prior_request, previous, prior_work) } else { plan(value, prior_request, previous, prior_work) }; }
        LegacyEditStages.child(value) => { resume if wide { large_child(value, prior_request, previous, prior_work) } else { child(value, prior_request, previous, prior_work) }; }
        LegacyEditStages.aggregate(value) => { resume if wide { wide_aggregate(value, prior_request, previous, prior_work) } else { aggregate(value, prior_request, previous, prior_work) }; }
    };
}
flow summarize_history(value: Completed, prior_request: string, previous: Previous, prior_work: PriorWork, wide: bool) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => stage(name, state, wide);
    return finish_history_summary(value, log) with {
        LegacyEditStages.plan(item) => { resume if wide { wide_plan(item, prior_request, previous, prior_work) } else { plan(item, prior_request, previous, prior_work) }; }
        LegacyEditStages.child(item) => { resume if wide { large_child(item, prior_request, previous, prior_work) } else { child(item, prior_request, previous, prior_work) }; }
        LegacyEditStages.aggregate(item) => { resume if wide { wide_aggregate(item, prior_request, previous, prior_work) } else { aggregate(item, prior_request, previous, prior_work) }; }
    };
}
flow historical(value: WorkFacts) -> HistoryWork {
    return HistoryWork { id = value.id, summary = value.summary, summary_source = value.summary_source, selection = value.selection, check = value.check, exit_code = value.exit_code };
}

// Subsequent operations use a single durable append-only book. Earlier fixed
// work/check records remain in place and continue to provide session history.
flow more(input: Work, prior_request: string, previous: Previous, first_id: string, check_digest: string, policy: Policy, binding: string, wide: bool) -> i32 {
    let second = match load_followup(policy, binding) { Ok(Some(value)) => value, _ => { return refused("completed followup required"); } };
    let work = second.value.work;
    if input.edit.id == first_id || input.edit.id == work.id { return refused("distinct work ID required"); }
    let facts = match work_snapshot(policy, binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    var latest = match facts.followup { Some(value) => value, None() => { return refused("followup facts missing"); } };
    var request = work.request; var history: Array<HistoryWork> = [];
    match facts.first { Some(value) => { history = history.push(historical(value)); } None() => {} }
    history = history.push(historical(latest));
    for value in facts.additional limit Iterations(48) { history = history.push(historical(value)); latest = value; }
    let extra = match load_extra(binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    match extra { Some(value) => { request = value.value.current.core.request; } None() => {} }
    let prior = PriorWork { request = request, summary = latest.summary, summary_source = latest.summary_source, selection = latest.selection, check = latest.check, exit_code = latest.exit_code, output = latest.output, history = history };
    let ticket = match admit_extra(binding, input.edit.id, input.edit.workspace, input.edit.path, input.edit.request, check_digest, policy, wide) { Ok(value) => value, Err(error) => { return refused(error); } };
    println(if wide { "RESERVED additional work: 7 calls, 286720 output tokens, 2811008 configured native tokens; interruption leaves this work unresolved." } else { "RESERVED additional work: 7 calls, 51200 output tokens, 1335296 configured native tokens; interruption leaves this work unresolved." });
    let pending = match prepare_history(input, prior_request, previous, prior, wide) { Ok(value) => value, Err(failure) => { ledger(failure.state, wide); return refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    let intent = match edit_intent(ticket, selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    let edited = match edit_complete(intent) { Ok(value) => value, Err(error) => { return refused("edit may have completed; " + error); } };
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    let captured = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    let summary = match summarize_history(captured, prior_request, previous, prior, wide) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    let records = match capture(pending, confirmed, summary) { Ok(value) => value, Err(error) => { return refused(error); } };
    match finish_extra(edited, summary.answer, if summary.model_generated { "model" } else { "system" }, summary.state, records, policy) { Ok(_) => {} Err(error) => { return refused("edit completed; " + error); } }
    match record_work(selected.id, records, policy, binding) { Ok(_) => {} Err(error) => { return refused("work saved; timeline incomplete: " + error); } }
    display("FINAL ", summary.answer); println("SAVED additional work facts"); ledger(summary.state, wide); return 0;
}

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<PolicyRoot>, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) < 2 || args[count(args) - 2] != "--policy-binding" { return refused("event followup requires policy binding"); }
    let binding = args[count(args) - 1];
    let parsed = match parse_recorded(args, 2, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    let input = parsed.input;
    if input.edit.help { return refused("select a current read root, owned edit root, target and task"); }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { return refused(error); } };
    let history = match load_chat(policy, binding) { Ok(Some(value)) => value, _ => { return refused("saved event chat required"); } };
    if history.value.chat.phase == "running" { return refused("chat turn unresolved"); }
    let first_work = match inspect_first_work(policy, binding) { Ok(Some(value)) => value, _ => { return refused("completed first work required"); } };
    if first_work.value.work.phase != "complete" && first_work.value.work.phase != "abandoned" { return refused("first work unresolved"); }
    match load_followup(policy, binding) {
        Ok(Some(_)) => { return more(input, history.value.chat.last_request, history.value.chat.invocation.prior, first_work.value.work.id, parsed.digest, policy, binding, history.value.chat.format >= 13); }
        Ok(None()) => {}
        Err(error) => { return refused(error); }
    }
    match available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let first_check = match inspect_first_check(policy, binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    var first_output: Option<CheckOutput> = None(); var checked = "not requested"; var exit = "";
    match first_check {
        Some(value) => {
            if value.value.check.phase == "abandoned" { checked = "abandoned; outcome unknown"; } else if first_work.value.work.phase == "abandoned" && value.value.check.phase == "planned" { checked = "not started after abandoned work"; } else {
            if value.value.check.phase != "complete" { return refused("first check outcome unresolved"); }
            let out = match decode(value.value.stdout, policy) { Ok(item) => item, Err(error) => { return refused(error); } };
            let err = match decode(value.value.stderr, policy) { Ok(item) => item, Err(error) => { return refused(error); } };
            first_output = Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = value.value.stdout_truncated, stderr_truncated = value.value.stderr_truncated });
            checked = value.value.check.outcome; exit = value.value.check.exit_code;
            }
        }
        None() => {}
    }
    match load_followup_check(policy, binding) { Ok(None()) => {} _ => { return refused("followup check exists or is invalid"); } }
    let origin = match summary_source(first_work.value.events, first_work.value.work.summary, policy) { Ok(value) => value, Err(error) => { return refused(error); } };
    let chosen = match selection(first_work.value.events.events, policy) { Ok(value) => value, Err(error) => { return refused(error); } };
    let ticket = match admit(input.edit.id, input.edit.workspace, input.edit.path, input.edit.request, history, policy, binding) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    if ticket.frame.parent_work_version != first_work.version.opaque { return refused("first work changed before followup"); }
    match first_check { Some(value) => { if ticket.frame.parent_check_version != value.version.opaque { return refused("first check changed before followup"); } } None() => { if ticket.frame.parent_check_version != "" { return refused("first check changed before followup"); } } }
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } }
    if parsed.has_check { match plan_check(ticket, parsed.digest, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } } }
    println("RESERVED event followup; interruption or uncertain effects cannot be retried automatically.");
    let prior_request = history.value.chat.last_request; let previous = history.value.chat.invocation.prior;
    let prior_work = PriorWork { request = first_work.value.work.request, summary = if first_work.value.work.phase == "abandoned" { "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit." } else { first_work.value.work.summary }, summary_source = if first_work.value.work.phase == "abandoned" { "system" } else { origin }, selection = chosen, check = checked, exit_code = exit, output = first_output, history = [] };
    let wide = ticket.frame.work.format == 3 || ticket.frame.work.format == 4 || ticket.frame.work.format == 6 || ticket.frame.work.format == 7;
    let pending = match prepare_history(input, prior_request, previous, prior_work, wide) { Ok(value) => value, Err(failure) => { ledger(failure.state, wide); return refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } }
    let intent = match begin(selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    match complete(intent) { Ok(_) => {} Err(error) => { return refused("edit may have completed; " + error); } }
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    println("POST_EDIT context");
    let captured = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    println("POST_EDIT aggregate");
    let summary = match summarize_history(captured, prior_request, previous, prior_work, wide) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    println("POST_EDIT events");
    let records = match capture(pending, confirmed, summary) { Ok(value) => value, Err(error) => { return refused("edit completed; " + error); } };
    println("POST_EDIT persist");
    match finish(ticket, summary.answer, summary.state, records, policy, binding) { Ok(_) => {} Err(error) => { return refused("edit completed; " + error); } }
    match record_work(selected.id, records, policy, binding) { Ok(_) => {} Err(error) => { return refused("work saved; timeline incomplete: " + error); } }
    display("FINAL ", summary.answer); println("SAVED event followup facts; no grant or root identity is persisted.");
    ledger(summary.state, wide); return 0;
}

public flow abandon(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) != 2 { return refused("recovery requires binding and operation ID"); }
    let policy = match load_policy() { Ok(value) => value, Err(error) => { return refused(error); } };
    let extra = match load_extra(args[0]) { Ok(value) => value, Err(error) => { return refused(error); } };
    let result = match extra {
        Some(item) => if item.value.current.result.phase == "complete" { abandon_extra_check(args[0], args[1]) } else { abandon_extra(args[0], args[1]) },
        None() => { let work = match load_followup(policy, args[0]) { Ok(Some(value)) => value, _ => { return refused("interrupted followup missing"); } }; if work.value.work.phase == "complete" { abandon_followup_check(args[1], policy, args[0]) } else { abandon_followup(args[1], policy, args[0]) } },
    };
    return match result { Ok(_) => { println("RECORDED user decision: abandoned; interrupted outcome remains unknown; saved budgets are retained."); 0 } Err(error) => refused(error) };
}
