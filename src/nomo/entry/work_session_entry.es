module nomo.entry.work_session_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;
import nomo.entry.edit_coordinator.Approval;
import nomo.cli.harness_work_args.parse;
import nomo.cli.edit_args.parse as selectors;
import nomo.harness.harness_work_contract.fresh;
import nomo.session.edit_operation.same_binding;
import nomo.session.edit_operation_store.available as edit_available;
import nomo.session.work_record.{partial, admit};
import nomo.session.work_record_store.{available, publish, complete, inspect};
import nomo.tools.edit_binding.bind;
import nomo.entry.edit_coordinator.execute;
import nomo.entry.edit_context.display;
import nomo.entry.harness_work_entry.{prepare_work, finish_edit, summarize, refused, ledger};
import nomo.entry.work_record_display.render;

public flow run_save(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let input = match parse(args) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if input.edit.help {
        println("work_save: --id ID --workspace BIND --path FILE --once TASK --allow FILE[,FILE]; one confirmed edit, one durable work record, no executable resume.");
        return 0;
    }
    match edit_available() { Ok(_) => {} Err(error) => { return refused(fresh(), error); } }
    match available(input.edit.id, input.edit.workspace, input.edit.path) { Ok(_) => {} Err(error) => { return refused(fresh(), error); } }
    let pending = match prepare_work(input) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let selected = pending.selected;
    let predicted = match bind(selected.id, selected.workspace, selected.path, pending.prepared) {
        Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    let candidate = match partial(predicted, pending.evidence, pending.task, pending.prepared) {
        Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    match admit(candidate) { Ok(_) => {} Err(error) => { return refused(pending.state, error); } }
    let outcome = match execute(selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    let completed = match finish_edit(pending, outcome) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    if !same_binding(outcome.binding, candidate.binding) || outcome.after != pending.prepared.proposal.after {
        return refused(completed.state, "edit completed; confirmed outcome differs from admitted work; work not saved");
    }
    println("WORK pending; edit completed; work record is not yet confirmed saved; no edit retry or rollback.");
    let ticket = match publish(candidate) { Ok(value) => value, Err(error) => { return refused(completed.state, "edit completed; work not confirmed saved; " + error); } };
    println("WORK durable edit-completed / summary-unconfirmed; reservation1 step/1 call/2048 generation/65536 native may be attempted; no resume or replay.");
    let summary = match summarize(completed) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    match complete(ticket, summary.answer) { Ok(_) => {} Err(error) => { return refused(summary.state, "edit completed; summary update not confirmed saved; " + error); } }
    println("SAVED work record summary-confirmed; edit and work records are separate commits.");
    display("FINAL ", summary.answer); ledger(summary.state); return 0;
}

public flow run_show(args: Array<string>) -> i32 {
    let input = match selectors(args, false) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    if input.help { println("work_show: --id ID --workspace BIND --path FILE; captured application data only, no executable resume."); return 0; }
    let row = match inspect(input.id, input.workspace, input.path) { Ok(Some(value)) => value,
        Ok(None()) => { println("WORK missing; a missing work record does not establish that no edit occurred."); return 0; }
        Err(error) => { println("REFUSED " + error); return 1; } };
    let lines = match render(row) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    for line in lines limit Iterations(7) { println(line); }
    println("Captured edit facts; current file state is not checked. Reservations are configured allowances, may have been attempted, and never authorize resume or replay.");
    return 0;
}
