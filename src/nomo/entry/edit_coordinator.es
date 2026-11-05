module nomo.entry.edit_coordinator;

import std.io.{println, read_line};
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.{trim, lowercase, char_count as len, from_usize};
import nomo.tools.edit_file.{EditableRoot, Prepared, apply};
import nomo.tools.edit_proposal.validate;
import nomo.tools.edit_binding.bind;
import nomo.ui.edit_diff.render;
import nomo.session.edit_operation.{Binding, selector_error};
import nomo.session.edit_operation_store.{begin, complete};
import nomo.core.json.encode as encode_json;
import nomo.core.large_context.edit_json_bytes;
import nomo.session.session_display.ascii_json_with;
public import nomo.application.edit.effects.Approval;
public import nomo.tools.edit_contract.{Selector, Confirmed};

type PreviewMachine = { format: string, id: string, workspace: string, region: string, path: string,
    before: string, target: string, replacement: string, after: string, before_bytes: string, after_bytes: string,
    before_digest: string, after_digest: string, request_digest: string };

flow preview(value: Prepared, selected: Binding) -> Result<string, string> {
    // The runtime codec owns the complete JSON representation. A final bounded
    // pass keeps Unicode, including invisible and bidirectional scalars, from
    // being emitted raw to the terminal.
    let machine = PreviewMachine { format = "nomo-edit-preview-v1", id = selected.id, workspace = selected.workspace,
        region = selected.region, path = selected.path, before = value.proposal.before, target = value.request.target,
        replacement = value.request.replacement, after = value.proposal.after, before_bytes = from_usize(selected.before_bytes),
        after_bytes = from_usize(selected.after_bytes), before_digest = selected.before_digest,
        after_digest = selected.after_digest, request_digest = selected.request_digest };
    let json = match encode_json(machine, "edit preview JSON conversion refused", "edit preview JSON encoding refused") {
        Ok(text) => text, Err(error) => { return Err(error); }
    };
    return ascii_json_with(json, edit_json_bytes(), edit_json_bytes(),
        "edit preview JSON input exceeds bound", "edit preview JSON output exceeds bound");
}

public type Preview = { binding: Binding, machine: string, diff: string };
public spec PreviewPresenter {
    flow present(self, preview: Preview) -> unit ![Console, Error<ConsoleError>];
}
public spec CurrentEditConsent {
    flow confirm(self, preview: Preview) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>];
}
public type TerminalPreview = {};
public type TerminalConsent = {};

public flow build_preview(selector: Selector, prepared: Prepared) -> Result<Preview, string> {
    let invalid = selector_error(selector.id, selector.workspace, selector.path); if invalid != "" { return Err(invalid); }
    if selector.path != prepared.request.path || selector.path != prepared.proposal.path { return Err("edit selector differs from prepared request"); }
    match validate(prepared.request, prepared.proposal) { Ok(_) => {} Err(error) => { return Err(error); } }
    let selected = match bind(selector.id, selector.workspace, selector.path, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    let shown = match preview(prepared, selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    let readable = match render(prepared.proposal.before, prepared.proposal.after) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Preview { binding = selected, machine = shown, diff = readable });
}
impl TerminalPreview ~ PreviewPresenter {
    flow present(self, preview: Preview) -> unit ![Console, Error<ConsoleError>] {
        println("PREVIEW " + preview.machine);
        println("DIFF request=" + preview.binding.request_digest + "\n" + preview.diff);
        println("WARNING File permissions, including executable bits, may change during this edit.");
        println("CONFIRM Native gate requires yes; then confirm this request with y/yes.");
    }
}
impl TerminalConsent ~ CurrentEditConsent {
    flow confirm(self, preview: Preview) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>] {
        let selected = preview.binding;
        let approved = perform Approval.request("Nomo edit " + selected.id + " request=" + selected.request_digest);
        if !approved { return Err("native approval denied; no intent or File write"); }
        println("CONFIRM Apply this exact preview? [y/N]");
        let raw = read_line();
        if len(raw) > 32 { return Err("application confirmation denied; no intent or File write"); }
        let answer = lowercase(trim(raw));
        if answer != "y" && answer != "yes" { return Err("application confirmation denied; no intent or File write"); }
        return Ok(selected);
    }
}
public flow confirm_using<P ~ PreviewPresenter, C ~ CurrentEditConsent>(presenter: P, consent: C, selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>, Error<IndexError>] {
    let shown = match build_preview(selector, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    presenter.present(shown);
    return consent.confirm(shown);
}
public flow confirm_current(selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<IndexError>, Error<ConsoleError>] {
    return confirm_using(TerminalPreview {}, TerminalConsent {}, selector, prepared);
}

public flow execute(selector: Selector, prepared: Prepared) -> Result<Confirmed, string> ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let selected = match confirm_current(selector, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    let ticket = match begin(selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    println("INTENT durable " + selector.id);
    match apply(prepared) { Ok(_) => {} Err(error) => { return Err(error); } }
    match complete(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    println("APPLIED " + selector.id);
    return Ok(Confirmed { binding = selected, after = prepared.proposal.after });
}

