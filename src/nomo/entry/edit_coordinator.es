module nomo.entry.edit_coordinator;

import std.io.{println, read_line};
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.{trim, lowercase, len, to_string_usize};
import nomo.tools.edit_file.{EditableRoot, Prepared, apply};
import nomo.tools.edit_proposal.validate;
import nomo.tools.edit_encoding.object;
import nomo.tools.edit_binding.bind;
import nomo.session.edit_operation.{Binding, selector_error};
import nomo.session.edit_operation_store.{begin, complete};

// The selected native Prompt adapter accepts this string -> bool payload.
public effect Approval { action request(reason: string) -> bool; }
public type Selector = { id: string, workspace: string, path: string };
public type Confirmed = { binding: Binding, after: string };
flow preview(value: Prepared, selected: Binding) -> Result<string, string> {
    return object(["format", "id", "workspace", "region", "path", "before", "target", "replacement", "after",
        "before_bytes", "after_bytes", "before_digest", "after_digest", "request_digest"],
        ["nomo-edit-preview-v1", selected.id, selected.workspace, selected.region, selected.path,
        value.proposal.before, value.request.target, value.request.replacement, value.proposal.after,
        to_string_usize(selected.before_bytes), to_string_usize(selected.after_bytes),
        selected.before_digest, selected.after_digest, selected.request_digest]);
}

// Both callers admit an unused slot before reading the original. No caller may
// infer completion from Console text or continue after an uncertain outcome.
public flow execute(selector: Selector, prepared: Prepared) -> Result<Confirmed, string> ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let invalid = selector_error(selector.id, selector.workspace, selector.path); if invalid != "" { return Err(invalid); }
    if selector.path != prepared.request.path || selector.path != prepared.proposal.path {
        return Err("edit selector differs from prepared request");
    }
    match validate(prepared.request, prepared.proposal) { Ok(_) => {} Err(error) => { return Err(error); } }
    let selected = match bind(selector.id, selector.workspace, selector.path, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    let shown = match preview(prepared, selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    println("PREVIEW " + shown);
    println("CONFIRM Native gate requires yes; then confirm this request with y/yes.");
    let approved = perform Approval.request("Nomo edit " + selector.id + " request=" + selected.request_digest);
    if !approved { return Err("native approval denied; no intent or File write"); }
    println("CONFIRM Apply this exact preview? [y/N]");
    let raw = read_line();
    if len(raw) > 32 { return Err("application confirmation denied; no intent or File write"); }
    let answer = lowercase(trim(raw));
    if answer != "y" && answer != "yes" { return Err("application confirmation denied; no intent or File write"); }
    let ticket = match begin(selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    println("INTENT durable " + selector.id);
    match apply(prepared) { Ok(_) => {} Err(error) => { return Err(error); } }
    match complete(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    println("APPLIED " + selector.id);
    return Ok(Confirmed { binding = selected, after = prepared.proposal.after });
}

