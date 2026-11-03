module nomo.entry.history_work;

import std.io.println;
import std.collections.len as count;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.{Work, parse_unicode as parse};
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.read_model_tools.work_child_turn;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.history_work_model.{read_main, plan, child, aggregate};
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.entry.harness_work_entry.{prepare_unicode, finish_edit, finish_history_summary, ledger, Pending, Failure, Completed, Summary};
import nomo.session.chat_history.load as load_chat;
import nomo.session.history_work_guard.{admit, claim, finish};
import nomo.session.history_check_guard.plan as plan_check;
import nomo.session.edit_operation_store.{available, begin, complete};
import nomo.entry.edit_coordinator.{Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, apply};

flow stage(name: string, value: Ledger) -> unit { println("STAGE " + name); ledger(value); }
flow prepare_history(input: Work, prior_request: string, previous: Previous) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => stage(name, state);
    return prepare_unicode(input, original, log) with {
        LegacyStringStages.main(value) => { resume read_main(value, prior_request, previous); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume plan(value, prior_request, previous); }
        LegacyEditStages.child(value) => { resume child(value, prior_request, previous); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value, prior_request, previous); }
    };
}
flow summarize_history(value: Completed, prior_request: string, previous: Previous) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => stage(name, state);
    return finish_history_summary(value, log) with {
        LegacyEditStages.plan(item) => { resume plan(item, prior_request, previous); }
        LegacyEditStages.child(item) => { resume child(item, prior_request, previous); }
        LegacyEditStages.aggregate(item) => { resume aggregate(item, prior_request, previous); }
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
    if input.edit.help { return refused("select a current read root, owned edit root, target and task"); }
    match available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let history = match load_chat() { Ok(Some(value)) => value, _ => { return refused("a saved prior chat turn is required"); } };
    let ticket = match admit(input.edit.id, input.edit.workspace, input.edit.path, input.edit.request, history) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    match claim(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    if has_check { match plan_check(ticket, check_digest) { Ok(_) => {} Err(error) => { return refused(error); } } }
    println("RESERVED history-work; failure or interruption cannot be retried automatically.");
    let prior_request = history.value.last_request; let previous = history.value.invocation.prior;
    let pending = match prepare_history(input, prior_request, previous) { Ok(value) => value, Err(failure) => { ledger(failure.state); return refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    match claim(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    let intent = match begin(selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    match complete(intent) { Ok(_) => {} Err(error) => { return refused("edit may have completed; " + error); } }
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    let captured = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    let summary = match summarize_history(captured, prior_request, previous) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    match finish(ticket, summary.answer, summary.state) { Ok(_) => {} Err(error) => { return refused("edit completed; " + error); } }
    display("FINAL ", summary.answer); println("SAVED history-work; captured history is not a root identity or grant.");
    ledger(summary.state); return 0;
}
