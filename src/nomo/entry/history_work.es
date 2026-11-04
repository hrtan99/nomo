module nomo.entry.history_work;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.{parse_recorded, application};
import nomo.harness.history_work_model.HistoryStages;
import nomo.harness.history_stages.{prepare_legacy, summarize_legacy};
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.entry.harness_work_entry.{finish_edit, ledger};
import nomo.session.chat_history.load as load_chat;
import nomo.session.history_work_guard.{admit, claim, finish};
import nomo.session.history_check_guard.plan as plan_check;
import nomo.session.edit_operation_store.{available, begin, complete};
import nomo.entry.edit_coordinator.{Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, apply};
import nomo.tools.edit_file.read_original;
import nomo.harness.edit_original.EditOriginal;
import nomo.model.harness_progress.HarnessProgress;
import nomo.model.diagnostic_output.DiagnosticOutput;

flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let parsed = match parse_recorded(args, 0, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    let cli = parsed.input;
    if cli.edit.help { return refused("select a current read root, owned edit root, target and task"); }
    let input = application(cli);
    match available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let history = match load_chat() { Ok(Some(value)) => value, _ => { return refused("a saved prior chat turn is required"); } };
    let ticket = match admit(input.selected.id, input.selected.workspace, input.selected.path, input.request, history) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    match claim(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    if parsed.has_check { match plan_check(ticket, parsed.digest) { Ok(_) => {} Err(error) => { return refused(error); } } }
    println("RESERVED history-work; failure or interruption cannot be retried automatically.");
    let prior_request = history.value.last_request; let previous = history.value.invocation.prior;
    let stages = HistoryStages { prior_request = prior_request, previous = previous, wide = false };
    let prepared = prepare_legacy(stages, input) with {
        EditOriginal.read(path) => { resume read_original(path); }
        HarnessProgress.write(line) => { println(line); resume; }
        DiagnosticOutput.write(line) => { println(line); resume; }
    };
    let pending = match prepared { Ok(value) => value, Err(failure) => { ledger(failure.state); return refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    match claim(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    let intent = match begin(selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    match complete(intent) { Ok(_) => {} Err(error) => { return refused("edit may have completed; " + error); } }
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    let captured = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    let summarized = summarize_legacy(stages, captured) with {
        HarnessProgress.write(line) => { println(line); resume; }
        DiagnosticOutput.write(line) => { println(line); resume; }
    };
    let summary = match summarized { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    match finish(ticket, summary.answer, summary.state) { Ok(_) => {} Err(error) => { return refused("edit completed; " + error); } }
    display("FINAL ", summary.answer); println("SAVED history-work; captured history is not a root identity or grant.");
    ledger(summary.state); return 0;
}
