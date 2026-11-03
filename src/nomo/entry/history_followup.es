module nomo.entry.history_followup;


import std.io.println;
import std.collections.len as count;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.{Work, parse_unicode as parse};
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.harness_work_contract.fresh as fresh_ledger;
import nomo.harness.read_model_tools.work_child_turn;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.history_followup_model.{read_main, plan, child, aggregate, PriorWork};
import nomo.harness.history_continue_model.CheckOutput;
import nomo.session.history_check_guard.inspect as inspect_first_check;
import nomo.session.check_output.load as load_check_output;
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.entry.harness_work_entry.{prepare_unicode, finish_edit, finish_history_summary, ledger, Pending, Failure, Completed, Summary};
import nomo.session.chat_history.load as load_chat;
import nomo.session.history_followup_guard.{admit, claim, finish};
import nomo.session.history_followup_check_guard.plan as plan_check;
import nomo.session.history_followup_edit_store.{available, begin, complete};
import nomo.entry.edit_coordinator.{Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, apply};

flow stage(name: string, value: Ledger) -> unit { println("STAGE " + name); ledger(value); }
flow prepare_history(input: Work, prior_request: string, previous: Previous, prior_work: PriorWork) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => stage(name, state);
    return prepare_unicode(input, original, log) with {
        LegacyStringStages.main(value) => { resume read_main(value, prior_request, previous, prior_work); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume plan(value, prior_request, previous, prior_work); }
        LegacyEditStages.child(value) => { resume child(value, prior_request, previous, prior_work); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value, prior_request, previous, prior_work); }
    };
}
flow summarize_history(value: Completed, prior_request: string, previous: Previous, prior_work: PriorWork) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => stage(name, state);
    return finish_history_summary(value, log) with {
        LegacyEditStages.plan(item) => { resume plan(item, prior_request, previous, prior_work); }
        LegacyEditStages.child(item) => { resume child(item, prior_request, previous, prior_work); }
        LegacyEditStages.aggregate(item) => { resume aggregate(item, prior_request, previous, prior_work); }
    };
}
flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    var work_args: Array<string> = []; var check_digest = ""; var i: usize = 0;
    let has_check = count(args) >= 2 && args[count(args) - 2] == "--check-ref";
    if has_check { check_digest = args[count(args) - 1]; }
    let limit = if has_check { count(args) - 2 } else { count(args) };
    while i < limit limit Iterations(32) { work_args = work_args.push(args[i]); i = i + 1; }
    if has_check && check_digest == "" { return refused("invalid check reference"); }
    let input = match parse(work_args) { Ok(value) => value, Err(error) => { return refused(error); } };
    if input.edit.help { return refused("select a current read root, private edit root, target and task"); }
    match available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let history = match load_chat() { Ok(Some(value)) => value, _ => { return refused("a saved prior chat turn is required"); } };
    let first_check = match inspect_first_check() { Ok(value) => value, Err(error) => { return refused(error); } };
    var first_output: Option<CheckOutput> = None();
    match first_check {
        Some(value) => {
            if value.phase != "complete" { return refused("first check outcome unresolved"); }
            let saved = match load_check_output("first", value.id, value.digest) { Ok(found) => found, Err(error) => { return refused(error); } };
            match saved { Some(found) => { first_output = Some(CheckOutput { stdout = found.stdout, stderr = found.stderr, stdout_truncated = found.stdout_truncated, stderr_truncated = found.stderr_truncated }); } None() => {} }
        }
        None() => {}
    }
    let ticket = match admit(input.edit.id, input.edit.workspace, input.edit.path, input.edit.request, history) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    if ticket.record.parent.check != first_check { return refused("first check changed before followup; no retry"); }
    match claim(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    if has_check { match plan_check(ticket, check_digest) { Ok(_) => {} Err(error) => { return refused(error); } } }
    println("RESERVED history-followup; failure or interruption cannot be retried automatically.");
    let prior_request = history.value.last_request; let previous = history.value.invocation.prior;
    let checked = match ticket.record.parent.check { Some(value) => value.outcome, None() => "not requested" };
    let exit = match ticket.record.parent.check { Some(value) => value.exit_code, None() => "" };
    let prior_work = PriorWork { request = ticket.record.parent.work.request, summary = ticket.record.parent.work.summary, summary_source = "unknown", selection = None(), check = checked, exit_code = exit, output = first_output };
    let pending = match prepare_history(input, prior_request, previous, prior_work) { Ok(value) => value, Err(failure) => { ledger(failure.state); return refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    match claim(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    let intent = match begin(selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    match complete(intent) { Ok(_) => {} Err(error) => { return refused("edit may have completed; " + error); } }
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    let captured = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    let summary = match summarize_history(captured, prior_request, previous, prior_work) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    match finish(ticket, summary.answer, summary.state) { Ok(_) => {} Err(error) => { return refused("edit completed; " + error); } }
    display("FINAL ", summary.answer); println("SAVED history-followup; captured history is not a root identity or grant.");
    ledger(summary.state); return 0;
}
