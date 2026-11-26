module nomo.adapters.cli.legacy.edit_entry;

import std.io.{println, IOError as ConsoleError};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.from_usize;
import nomo.adapters.cli.arguments.edit_args.parse;
import nomo.tools.edit_file.EditableRoot;
import nomo.adapters.filesystem.legacy.edit_file.prepare;
import nomo.domain.mutations.edit_encoding.object;
import nomo.session.edit_operation.Record;
import nomo.adapters.storage.legacy.edit_operation_store.{available, inspect};
import nomo.application.edit.effects.Approval;
import nomo.domain.mutations.edit_contract.Selector;
import nomo.adapters.cli.legacy.edit_coordinator.execute;

let REGION = "nomo.tools.edit_file.EditableRoot";

flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }
flow help() -> unit {
    println("Owned disposable edit: etas run PROJECT --flow edit_apply --allow-effects --args --id ID --workspace BIND --path FILE --target TEXT --replacement TEXT");
    println("Recorded status: --flow edit_status with --id ID --workspace BIND --path FILE. Help: --flow edit_help.");
    println("One existing regular NUL-free UTF-8 file, at most 1048576 bytes before and after, in an exclusive owned workspace without symlinks or other writers.");
    println("Two current prompts: native Prompt requires yes on a TTY; Nomo then accepts trimmed y/yes. Denial, blank or EOF does not apply.");
    println("One fixed journal slot per fresh private store; interrupted/uncertain work cannot replay. Status is data-only, not current-file verification.");
}

public flow run_help(args: Array<string>) -> i32 {
    if args.len() > 1 || (args.len() == 1 && args[0] != "help" && args[0] != "--help") { return refused("edit help accepts no selectors"); }
    help(); return 0;
}

public flow run_apply(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>, Error<BudgetExceeded>] {
    let options = match parse(args, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    match available() { Ok(_) => (), Err(error) => { return refused(error); } }
    let prepared = match prepare(options.path, options.target, options.replacement) { Ok(value) => value, Err(error) => { return refused(error); } };
    let selector = Selector { id = options.id, workspace = options.workspace, path = options.path };
    return match execute(selector, prepared) { Ok(_) => 0, Err(error) => refused(error) };
}

flow status_record(value: Record) -> Result<string, string> {
    let selected = value.binding;
    return object(["format", "phase", "id", "workspace", "region", "path", "request_digest", "before_digest", "after_digest", "before_bytes", "after_bytes"],
        ["nomo-edit-operation-v1", value.phase, selected.id, selected.workspace, selected.region, selected.path,
        selected.request_digest, selected.before_digest, selected.after_digest, from_usize(selected.before_bytes), from_usize(selected.after_bytes)]);
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
