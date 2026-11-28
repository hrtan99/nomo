module nomo.application.editing.workflow;

import nomo.application.editing.ports.{
    Approval as ports_Approval,
    CurrentEditConsent,
    EditOriginal,
    Preview,
    PreviewPresenter,
    Run,
    WorkConfirmation,
    WorkEditor,
    WorkOutputSink,
    WorkPersistence,
    WorkStages,
    WorkTimeline
};
import nomo.application.harness.ports.{DiagnosticOutput, HarnessProgress};
import nomo.application.harness.work.complete;
import nomo.application.resources.{EditableRoot, ReadOnlyRoot};
import nomo.application.sessions.ports.EditJournal;
import nomo.domain.conversation.TraceEvent;
import nomo.domain.editing.{Binding, Confirmed, Prepared, Selector, bind, render_edit, selector_error, validate};
import nomo.domain.limits.edit_json_bytes;
import nomo.domain.sessions.work.WorkRequest;
import nomo.domain.wire.{ascii_json_with, encode};
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.IOError;
import std.text.from_usize;

type PreviewMachine = {
    format: string,
    id: string,
    workspace: string,
    region: string,
    path: string,
    before: string,
    target: string,
    replacement: string,
    after: string,
    before_bytes: string,
    after_bytes: string,
    before_digest: string,
    after_digest: string,
    request_digest: string
};

flow preview(value: Prepared, selected: Binding) -> Result<string, string> {
    // The runtime codec owns the complete JSON representation. A final bounded
    // pass keeps Unicode, including invisible and bidirectional scalars, from
    // being emitted raw to the terminal.
    let machine = PreviewMachine {
        format = "nomo-edit-preview-v1",
        id = selected.id,
        workspace = selected.workspace,
        region = selected.region,
        path = selected.path,
        before = value.proposal.before,
        target = value.request.target,
        replacement = value.request.replacement,
        after = value.proposal.after,
        before_bytes = from_usize(selected.before_bytes),
        after_bytes = from_usize(selected.after_bytes),
        before_digest = selected.before_digest,
        after_digest = selected.after_digest,
        request_digest = selected.request_digest
    };
    let json = match encode(
        machine,
        "edit preview JSON conversion refused",
        "edit preview JSON encoding refused"
    ) {
        Ok(text) => text,
        Err(error) => {
            return Err(error);
        }
    };
    return ascii_json_with(
        json,
        edit_json_bytes(),
        edit_json_bytes(),
        "edit preview JSON input exceeds bound",
        "edit preview JSON output exceeds bound"
    );
}

public flow build_preview(selector: Selector, prepared: Prepared) -> Result<Preview, string> {
    let invalid = selector_error(selector.id, selector.workspace, selector.path);
    if invalid != "" {
        return Err(invalid);
    }
    if selector.path != prepared.request.path || selector.path != prepared.proposal.path {
        return Err("edit selector differs from prepared request");
    }
    match validate(prepared.request, prepared.proposal) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let selected = match bind(selector.id, selector.workspace, selector.path, prepared) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let shown = match preview(prepared, selected) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let readable = match render_edit(
        prepared.proposal.before,
        prepared.request.target,
        prepared.request.replacement,
        prepared.proposal.after
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Preview {
        binding = selected,
        machine = shown,
        diff = readable
    });
}

public flow confirm_using<P ~ PreviewPresenter, C ~ CurrentEditConsent>(
    presenter: P,
    consent: C,
    selector: Selector,
    prepared: Prepared
) -> Result<Binding, string> ![
    Console,
    ports_Approval,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let shown = match build_preview(selector, prepared) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    presenter.present(shown);
    return consent.confirm(shown);
}

public flow execute_execute<E ~ WorkEditor, J ~ EditJournal, C ~ WorkConfirmation, O ~ WorkOutputSink>(
    files: E,
    journal: J,
    consent: C,
    output: O,
    selector: Selector,
    prepared: Prepared
) -> Result<Confirmed, string> ![
    Console,
    Memory,
    ports_Approval,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let selected = match consent.confirm(selector, prepared) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let ticket = match journal.begin(selected) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    output.progress("INTENT durable " + selector.id);
    match files.apply(prepared) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    match journal.complete(ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    output.progress("APPLIED " + selector.id);
    return Ok(Confirmed {
        binding = selected,
        after = prepared.proposal.after
    });
}

// The application owns the order. Concrete confirmation, file IO, event
// capture, timeline storage and terminal presentation are supplied as ports.
public flow work_controller_execute<
    S ~ WorkStages,
    Intent,
    Edited,
    P ~ WorkPersistence<Intent, Edited>,
    E ~ WorkEditor,
    C ~ WorkConfirmation,
    T ~ WorkTimeline,
    O ~ WorkOutputSink
>(stages: S, persistence: P, editor: E, confirmation: C, timeline: T, output: O, input: WorkRequest, run: Run) -> i32 ![
    Console,
    Memory,
    ports_Approval,
    Fs.read<ReadOnlyRoot>,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let prepared = stages.prepare(input) with {
        EditOriginal.read(path) => editor.read_original(path);
        HarnessProgress.write(line) => output.progress(line);
        DiagnosticOutput.write(line) => output.diagnostic(line);
    };
    let pending = match prepared {
        Ok(value) => value,
        Err(failure) => {
            output.ledger(failure.state, run.wide, run.high_input);
            return output.refused(failure.error);
        }
    };
    let selected = match confirmation.confirm(pending.selected, pending.prepared) {
        Ok(value) => value,
        Err(error) => {
            return output.refused(error);
        }
    };
    let begun: Result<Intent, string> = persistence.begin(selected);
    let intent = match begun {
        Ok(value) => value,
        Err(error) => {
            return output.refused(error);
        }
    };
    output.progress("INTENT durable " + selected.id);
    match editor.apply(pending.prepared) {
        Ok(_) => (),
        Err(error) => {
            return output.refused(error);
        }
    }
    let finished: Result<Edited, string> = persistence.complete(intent);
    let edited = match finished {
        Ok(value) => value,
        Err(error) => {
            return output.refused("edit may have completed; " + error);
        }
    };
    output.progress("APPLIED " + selected.id);
    let confirmed = Confirmed {
        binding = selected,
        after = pending.prepared.proposal.after
    };
    output.recorded(pending.selected);
    output.progress("POST_EDIT context");
    let completed = match complete(pending, confirmed) {
        Ok(value) => value,
        Err(failure) => {
            return output.refused(failure.error);
        }
    };
    output.progress("POST_EDIT aggregate");
    let summarized = stages.summarize(completed) with {
        HarnessProgress.write(line) => output.progress(line);
        DiagnosticOutput.write(line) => output.diagnostic(line);
    };
    let summary = match summarized {
        Ok(value) => value,
        Err(failure) => {
            return output.refused(failure.error);
        }
    };
    var records: Array<TraceEvent> = [];
    if timeline.enabled() {
        output.progress("POST_EDIT events");
        records = match timeline.capture(pending, confirmed, summary) {
            Ok(value) => value,
            Err(error) => {
                return output.refused("edit completed; " + error);
            }
        };
    }
    output.progress("POST_EDIT persist");
    match persistence.finish(edited, summary, records) {
        Ok(_) => (),
        Err(error) => {
            return output.refused("edit completed; " + error);
        }
    }
    if timeline.enabled() {
        match timeline.save(selected.id, records, run.redaction, run.binding) {
            Ok(_) => (),
            Err(error) => {
                return output.refused("work saved; timeline incomplete: " + error);
            }
        }
    }
    return output.completed(summary.answer, run.saved, summary.state, run.wide, run.high_input);
}
