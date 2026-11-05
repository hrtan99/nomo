module nomo.application.work.controller;

import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.edit.effects.Approval;
import nomo.core.conversation.Event;
import nomo.application.harness.work.controller.complete;
import nomo.application.work.request.WorkRequest;
import nomo.application.work.ports.{WorkStages, WorkPersistence, WorkEditor, WorkTimeline, Run};
import nomo.application.work_output.WorkOutputSink;
import nomo.harness.edit_original.EditOriginal;
import nomo.model.diagnostic_output.DiagnosticOutput;
import nomo.model.harness_progress.HarnessProgress;
import nomo.tools.edit_contract.Confirmed;
import nomo.tools.edit_file.EditableRoot;
import nomo.tools.workspace.ReadOnlyRoot;

// The application owns the order. Concrete confirmation, file IO, event
// capture, timeline storage and terminal presentation are supplied as ports.
public flow execute<S ~ WorkStages, Intent, Edited, P ~ WorkPersistence<Intent, Edited>, E ~ WorkEditor, T ~ WorkTimeline, O ~ WorkOutputSink>(stages: S, persistence: P, editor: E, timeline: T, output: O, input: WorkRequest, run: Run) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let prepared = stages.prepare(input) with {
        EditOriginal.read(path) => { resume editor.read_original(path); }
        HarnessProgress.write(line) => { output.progress(line); resume; }
        DiagnosticOutput.write(line) => { output.diagnostic(line); resume; }
    };
    let pending = match prepared { Ok(value) => value, Err(failure) => { output.ledger(failure.state, run.wide); return output.refused(failure.error); } };
    let selected = match editor.confirm(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return output.refused(error); } };
    let begun: Result<Intent, string> = persistence.begin(selected);
    let intent = match begun { Ok(value) => value, Err(error) => { return output.refused(error); } };
    output.progress("INTENT durable " + selected.id);
    match editor.apply(pending.prepared) { Ok(_) => {} Err(error) => { return output.refused(error); } }
    let finished: Result<Edited, string> = persistence.complete(intent);
    let edited = match finished { Ok(value) => value, Err(error) => { return output.refused("edit may have completed; " + error); } };
    output.progress("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    output.recorded(pending.selected);
    output.progress("POST_EDIT context");
    let completed = match complete(pending, confirmed) { Ok(value) => value, Err(failure) => { return output.refused(failure.error); } };
    output.progress("POST_EDIT aggregate");
    let summarized = stages.summarize(completed) with {
        HarnessProgress.write(line) => { output.progress(line); resume; }
        DiagnosticOutput.write(line) => { output.diagnostic(line); resume; }
    };
    let summary = match summarized { Ok(value) => value, Err(failure) => { return output.refused(failure.error); } };
    var records: Array<Event> = [];
    if timeline.enabled() {
        output.progress("POST_EDIT events");
        records = match timeline.capture(pending, confirmed, summary) { Ok(value) => value, Err(error) => { return output.refused("edit completed; " + error); } };
    }
    output.progress("POST_EDIT persist");
    match persistence.finish(edited, summary, records) { Ok(_) => {} Err(error) => { return output.refused("edit completed; " + error); } }
    if timeline.enabled() {
        match timeline.save(selected.id, records, run.redaction, run.binding) { Ok(_) => {} Err(error) => { return output.refused("work saved; timeline incomplete: " + error); } }
    }
    return output.completed(summary.answer, run.saved, summary.state, run.wide);
}
