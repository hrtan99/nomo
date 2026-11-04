module nomo.entry.work_controller;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.Work;

import nomo.entry.harness_work_entry.{finish_edit, expanded_ledger, simple_refused};
public import nomo.application.work_contract.{Pending, Failure, Completed, Summary, WorkStages, WorkPersistence, Run};
import nomo.entry.edit_coordinator.{Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.harness.edit_original.EditApplier;
import nomo.tools.edit_file.{EditableRoot, WideEditFile};
import nomo.tools.workspace.ReadOnlyRoot;


import nomo.session.work_fact_events.capture;
import nomo.session.recoverable_chat_store.record_work;

// Admission stays with each use case. This order is shared after admission;
// journal, facts and timeline remain separate commits with observable interruption.
public flow execute<S ~ WorkStages, I, E, P ~ WorkPersistence<I, E>>(stages: S, persistence: P, input: Work, run: Run) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let pending = match stages.prepare(input) { Ok(value) => value, Err(failure) => { expanded_ledger(failure.state, run.wide); return simple_refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return simple_refused(error); } };
    let begun: Result<I, string> = persistence.begin(selected);
    let intent = match begun { Ok(value) => value, Err(error) => { return simple_refused(error); } };
    println("INTENT durable " + selected.id);
    let file = WideEditFile {};
    match file.apply(pending.prepared) { Ok(_) => {} Err(error) => { return simple_refused(error); } }
    let completion: Result<E, string> = persistence.complete(intent);
    let edited = match completion { Ok(value) => value, Err(error) => { return simple_refused("edit may have completed; " + error); } };
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    println("POST_EDIT context");
    let completed = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return simple_refused(failure.error); } };
    println("POST_EDIT aggregate");
    let summary = match stages.summarize(completed) { Ok(value) => value, Err(failure) => { return simple_refused(failure.error); } };
    println("POST_EDIT events");
    let records = match capture(pending, confirmed, summary) { Ok(value) => value, Err(error) => { return simple_refused("edit completed; " + error); } };
    println("POST_EDIT persist");
    match persistence.finish(edited, summary, records) { Ok(_) => {} Err(error) => { return simple_refused("edit completed; " + error); } }
    match record_work(selected.id, records, run.redaction, run.binding) { Ok(_) => {} Err(error) => { return simple_refused("work saved; timeline incomplete: " + error); } }
    display("FINAL ", summary.answer); println(run.saved); expanded_ledger(summary.state, run.wide); return 0;
}
