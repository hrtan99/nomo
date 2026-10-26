module nomo.entry.edit_entry;

import std.io.{println, read_line};
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.{trim, lowercase, len, to_string_usize};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.cli.edit_args.parse;
import nomo.cli.edit_args.Options;
import nomo.tools.edit_file.{EditableRoot, Prepared, prepare, apply};
import nomo.tools.edit_encoding.{json, object, digest};
import nomo.session.edit_operation.{Binding, Record, binding_error};
import nomo.session.edit_operation_store.{available, begin, complete, inspect};

// Native Approval Host payload is string -> bool. This canonical action reaches
// the selected Prompt adapter; it does not implement an application substitute.
effect Approval { action request(reason: string) -> bool; }
let REGION = "nomo.tools.edit_file.EditableRoot";

flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }
flow help() -> unit {
    println("Owned disposable edit: etas run PROJECT --flow edit_apply --allow-effects --args --id ID --workspace BIND --path FILE --target TEXT --replacement TEXT");
    println("Recorded status: --flow edit_status with --id ID --workspace BIND --path FILE. Help: --flow edit_help.");
    println("One existing regular NUL-free UTF-8 file, at most 2048 bytes before and after, in an exclusive private workspace without symlinks or other writers.");
    println("Two current prompts: native Prompt requires yes on a TTY; Nomo then accepts trimmed y/yes. Denial, blank or EOF does not apply.");
    println("One fixed journal slot per fresh private store; interrupted/uncertain work cannot replay. Status is data-only, not current-file verification.");
}

flow binding(options: Options, value: Prepared) -> Result<Binding, string> {
    let proposal = value.proposal;
    let canonical = match json(["nomo-edit-request-v1", options.id, options.workspace, REGION, proposal.path,
        proposal.before, options.target, options.replacement, proposal.after]) { Ok(item) => item, Err(error) => { return Err(error); } };
    let before = match digest(proposal.before) { Ok(item) => item, Err(error) => { return Err(error); } };
    let after = match digest(proposal.after) { Ok(item) => item, Err(error) => { return Err(error); } };
    let request = match digest(canonical) { Ok(item) => item, Err(error) => { return Err(error); } };
    let result = Binding { id = options.id, workspace = options.workspace, region = REGION, path = proposal.path,
        request_digest = request, before_digest = before, after_digest = after,
        before_bytes = byte_count(utf8_encode(proposal.before)), after_bytes = byte_count(utf8_encode(proposal.after)) };
    let invalid = binding_error(result); if invalid != "" { return Err(invalid); }
    return Ok(result);
}

flow preview(value: Prepared, selected: Binding) -> Result<string, string> {
    return object(["format", "id", "workspace", "region", "path", "before", "target", "replacement", "after",
        "before_bytes", "after_bytes", "before_digest", "after_digest", "request_digest"],
        ["nomo-edit-preview-v1", selected.id, selected.workspace, selected.region, selected.path,
        value.proposal.before, value.request.target, value.request.replacement, value.proposal.after,
        to_string_usize(selected.before_bytes), to_string_usize(selected.after_bytes),
        selected.before_digest, selected.after_digest, selected.request_digest]);
}

public flow run_help(args: Array<string>) -> i32 {
    if count(args) > 1 || (count(args) == 1 && args[0] != "help" && args[0] != "--help") { return refused("edit help accepts no selectors"); }
    help(); return 0;
}

public flow run_apply(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let options = match parse(args, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    match available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let prepared = match prepare(options.path, options.target, options.replacement) { Ok(value) => value, Err(error) => { return refused(error); } };
    let selected = match binding(options, prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    let shown = match preview(prepared, selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("PREVIEW " + shown);
    println("CONFIRM Native gate requires yes; then confirm this request with y/yes.");
    let approved = perform Approval.request("Nomo edit " + options.id + " request=" + selected.request_digest);
    if !approved { return refused("native approval denied; no intent or File write"); }
    println("CONFIRM Apply this exact preview? [y/N]");
    let raw = read_line();
    if len(raw) > 32 { return refused("application confirmation denied; no intent or File write"); }
    let answer = lowercase(trim(raw));
    if answer != "y" && answer != "yes" { return refused("application confirmation denied; no intent or File write"); }
    let ticket = match begin(selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + options.id);
    match apply(prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    match complete(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    println("APPLIED " + options.id); return 0;
}

flow status_record(value: Record) -> Result<string, string> {
    let selected = value.binding;
    return object(["format", "phase", "id", "workspace", "region", "path", "request_digest", "before_digest", "after_digest", "before_bytes", "after_bytes"],
        ["nomo-edit-operation-v1", value.phase, selected.id, selected.workspace, selected.region, selected.path,
        selected.request_digest, selected.before_digest, selected.after_digest, to_string_usize(selected.before_bytes), to_string_usize(selected.after_bytes)]);
}

// Separate entry: no Approval, File action, Console input or Memory mutation.
public flow run_status(args: Array<string>) -> i32 {
    let options = match parse(args, false) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    let stored = match inspect(options.id, options.workspace, options.path) { Ok(value) => value, Err(error) => { return refused(error); } };
    let shown = match stored {
        Some(value) => status_record(value),
        None() => object(["format", "phase", "id", "workspace", "region", "path"],
            ["nomo-edit-operation-v1", "empty", options.id, options.workspace, REGION, options.path]),
    };
    let output = match shown { Ok(value) => value, Err(error) => { return refused(error); } };
    println("OPERATION " + output);
    println("Recorded operation only; current file state is not checked."); return 0;
}
