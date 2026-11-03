module nomo.entry.recoverable_history_followup;

import std.io.println;
import std.collections.len as count;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.{Work, parse};
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.harness_work_contract.fresh as fresh_ledger;
import nomo.harness.harness_model_tools.work_child_turn;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.history_followup_model.{read_main, plan, child, aggregate, PriorWork};
import nomo.harness.history_continue_model.CheckOutput;
import nomo.session.event_policy.{PolicyRoot, load as load_policy};
import nomo.session.recoverable_check_store.load as inspect_first_check;
import nomo.session.recoverable_work_store.load as inspect_first_work;
import nomo.session.event_text_codec.decode;

import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.entry.harness_work_entry.{prepare, finish_edit, finish_summary, ledger, Pending, Failure, Completed, Summary};
import nomo.session.recoverable_chat_store.load as load_chat;
import nomo.session.recoverable_followup_store.{admit, claim, finish};
import nomo.session.recoverable_followup_check_store.{plan as plan_check, load as load_followup_check};
import nomo.session.work_fact_events.capture;
import nomo.session.history_followup_edit_store.{available, begin, complete};
import nomo.entry.edit_coordinator.{Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, apply};

flow stage(name: string, value: Ledger) -> unit { println("STAGE " + name); ledger(value); }
flow prepare_history(input: Work, prior_request: string, previous: Previous, prior_work: PriorWork) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => stage(name, state);
    return prepare(input, original, log, false, false, false) with {
        LegacyStringStages.main(value) => { resume read_main(value, prior_request, previous, prior_work); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume plan(value, prior_request, previous, prior_work); }
        LegacyEditStages.child(value) => { resume child(value, prior_request, previous, prior_work); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value, prior_request, previous, prior_work); }
    };
}
flow summarize_history(value: Completed, prior_request: string, previous: Previous, prior_work: PriorWork) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => stage(name, state);
    return finish_summary(value, log, false, false) with {
        LegacyEditStages.plan(item) => { resume plan(item, prior_request, previous, prior_work); }
        LegacyEditStages.child(item) => { resume child(item, prior_request, previous, prior_work); }
        LegacyEditStages.aggregate(item) => { resume aggregate(item, prior_request, previous, prior_work); }
    };
}
flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<PolicyRoot>, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) < 2 || args[count(args) - 2] != "--policy-binding" { return refused("event followup requires policy binding"); }
    let binding = args[count(args) - 1];
    var work_args: Array<string> = []; var check_digest = ""; var i: usize = 0;
    let has_check = count(args) >= 4 && args[count(args) - 4] == "--check-ref";
    if has_check { check_digest = args[count(args) - 3]; }
    let limit = if has_check { count(args) - 4 } else { count(args) - 2 };
    while i < limit limit Iterations(32) { work_args = work_args.push(args[i]); i = i + 1; }
    if has_check && check_digest == "" { return refused("invalid check reference"); }
    let input = match parse(work_args) { Ok(value) => value, Err(error) => { return refused(error); } };
    if input.edit.help { return refused("select a current read root, private edit root, target and task"); }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { return refused(error); } };
    match available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let history = match load_chat(policy, binding) { Ok(Some(value)) => value, _ => { return refused("saved event chat required"); } };
    let first_work = match inspect_first_work(policy, binding) { Ok(Some(value)) => value, _ => { return refused("completed first work required"); } };
    if first_work.value.work.phase != "complete" { return refused("first work unresolved"); }
    let first_check = match inspect_first_check(policy, binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    var first_output: Option<CheckOutput> = None(); var checked = "not requested"; var exit = "";
    match first_check {
        Some(value) => {
            if value.value.check.phase != "complete" { return refused("first check outcome unresolved"); }
            let out = match decode(value.value.stdout, policy) { Ok(item) => item, Err(error) => { return refused(error); } };
            let err = match decode(value.value.stderr, policy) { Ok(item) => item, Err(error) => { return refused(error); } };
            first_output = Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = value.value.stdout_truncated, stderr_truncated = value.value.stderr_truncated });
            checked = value.value.check.outcome; exit = value.value.check.exit_code;
        }
        None() => {}
    }
    match load_followup_check(policy, binding) { Ok(None()) => {} _ => { return refused("followup check exists or is invalid"); } }
    let ticket = match admit(input.edit.id, input.edit.workspace, input.edit.path, input.edit.request, history, policy, binding) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    if ticket.frame.parent_work_version != first_work.version.opaque { return refused("first work changed before followup"); }
    match first_check { Some(value) => { if ticket.frame.parent_check_version != value.version.opaque { return refused("first check changed before followup"); } } None() => { if ticket.frame.parent_check_version != "" { return refused("first check changed before followup"); } } }
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } }
    if has_check { match plan_check(ticket, check_digest, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } } }
    println("RESERVED event followup; interruption or uncertain effects cannot be retried automatically.");
    let prior_request = history.value.chat.last_request; let previous = history.value.chat.invocation.prior;
    let prior_work = PriorWork { request = first_work.value.work.request, summary = first_work.value.work.summary, check = checked, exit_code = exit, output = first_output };
    let pending = match prepare_history(input, prior_request, previous, prior_work) { Ok(value) => value, Err(failure) => { ledger(failure.state); return refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } }
    let intent = match begin(selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    match complete(intent) { Ok(_) => {} Err(error) => { return refused("edit may have completed; " + error); } }
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    let captured = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    let summary = match summarize_history(captured, prior_request, previous, prior_work) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    let records = match capture(pending, confirmed, summary) { Ok(value) => value, Err(error) => { return refused("edit completed; " + error); } };
    match finish(ticket, summary.answer, summary.state, records, policy, binding) { Ok(_) => {} Err(error) => { return refused("edit completed; " + error); } }
    display("FINAL ", summary.answer); println("SAVED event followup facts; no grant or root identity is persisted.");
    ledger(summary.state); return 0;
}
