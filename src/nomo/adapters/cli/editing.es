module nomo.adapters.cli.editing;

import nomo.adapters.cli.console.{display, recorded};
import nomo.adapters.cli.edit_input.edit_args_parse;
import nomo.adapters.filesystem.editing.{LegacyWorkEditor, prepare};
import nomo.adapters.storage.edits.{FirstEditJournal, edit_operation_store_available, edit_operation_store_inspect};
import nomo.application.editing.ports.{
    Approval as ports_Approval,
    CurrentEditConsent,
    Preview,
    PreviewPresenter,
    WorkConfirmation,
    WorkOutputSink
};
import nomo.application.editing.workflow.{build_preview, confirm_using, execute_execute};
import nomo.application.harness.work.historical_ledger_text;
import nomo.domain.editing.{Confirmed, Prepared, Selector};
import nomo.domain.sessions.work.validate;
import nomo.domain.wire.object;
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.edit_operation.{Binding, Record};
import nomo.session.work_record.Record as work_record_Record;
import nomo.tools.edit_file.EditableRoot;
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println, read_line};
import std.text.{char_count, from_i32, from_usize, lowercase, trim};

public type TerminalPreview = {};

public type TerminalConsent = {};

impl TerminalPreview ~ PreviewPresenter {
    flow present(self, preview: Preview) -> unit ![Console, Error<IOError>] {
        println("PREVIEW " + preview.machine);
        println("DIFF request=" + preview.binding.request_digest + "\n" + preview.diff);
        println("WARNING File permissions, including executable bits, may change during this edit.");
        println("CONFIRM Native gate requires yes; then confirm this request with y/yes.");
    }
}

impl TerminalConsent ~ CurrentEditConsent {
    flow confirm(self, preview: Preview) -> Result<Binding, string> ![Console, ports_Approval, Error<IOError>] {
        let selected = preview.binding;
        let approved = perform ports_Approval.request("Nomo edit " + selected.id + " request=" + selected.request_digest);
        if !approved { return Err("native approval denied; no intent or File write"); }
        println("CONFIRM Apply this exact preview? [y/N]");
        let raw = read_line();
        if char_count(raw) > 32 { return Err("application confirmation denied; no intent or File write"); }
        let answer = lowercase(trim(raw));
        if answer != "y" && answer != "yes" { return Err("application confirmation denied; no intent or File write"); }
        return Ok(selected);
    }
}

impl TerminalPreview ~ WorkConfirmation {
    flow confirm(self, selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, ports_Approval, Error<IndexError>, Error<IOError>, Error<BudgetExceeded>] {
        return confirm_using(self, TerminalConsent {}, selector, prepared);
    }
}

public flow confirm_current(selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, ports_Approval, Error<IndexError>, Error<IOError>, Error<BudgetExceeded>] {
    return TerminalPreview {}.confirm(selector, prepared);
}

public flow execute(selector: Selector, prepared: Prepared) -> Result<Confirmed, string> ![Console, Memory, ports_Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] {
    return execute_execute(LegacyWorkEditor {}, FirstEditJournal {}, TerminalPreview {}, LegacyWorkOutput {}, selector, prepared);
}

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

public flow run_apply(args: Array<string>) -> i32 ![Console, Memory, ports_Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] {
    let options = match edit_args_parse(args, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    match edit_operation_store_available() { Ok(_) => (), Err(error) => { return refused(error); } }
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
    let options = match edit_args_parse(args, false) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    let stored = match edit_operation_store_inspect(options.id, options.workspace, options.path) { Ok(value) => value, Err(error) => { return refused(error); } };
    let shown = match stored {
        Some(value) => status_record(value),
        None() => object(["format", "phase", "id", "workspace", "region", "path"],
            ["nomo-edit-operation-v1", "empty", options.id, options.workspace, REGION, options.path]),
    };
    let output = match shown { Ok(value) => value, Err(error) => { return refused(error); } };
    println("OPERATION " + output);
    println("Recorded operation only; current file state is not checked."); return 0;
}

public flow render(row: work_record_Record) -> Result<Array<string>, string> {
    let value = match validate(row) { Ok(item) => item, Err(error) => { return Err(error); } };
    let binding = value.binding; let read = value.evidence; let state = value.ledger;
    var allowed2 = ""; if read.allowed.len() == 2 { allowed2 = read.allowed[1]; }
    var selected2 = ""; if read.files.len() == 2 { selected2 = read.files[1]; }
    let remaining = if row.phase == "summary-confirmed" { ["0", "0", "0", "0"] } else { ["1", "1", "2048", "65536"] };
    let labels = ["WORK ", "READ ", "EDIT ", "READ_LEDGER ", "EDIT_LEDGER ", "MAXIMA ", "RESERVATION "];
    let keys = [["format", "phase", "id", "workspace", "region", "path", "request_digest", "before_digest", "after_digest", "before_bytes", "after_bytes"],
        ["request", "task", "operation", "allowed1", "allowed2", "selected1", "selected2", "literal", "outcome", "result", "summary"],
        ["task", "target", "replacement", "before", "after", "summary"],
        ["steps", "calls", "generation", "tools", "scan"], ["steps", "calls", "generation", "native_tokens", "boundaries"],
        ["steps", "calls", "generation", "native_tokens", "read_tools", "scan", "edit_reads", "edit_read_bytes", "atomic_attempts", "edit_bytes"],
        ["steps", "calls", "generation", "native_tokens"]];
    let values = [["nomo-work-record-v1", row.phase, binding.id, binding.workspace, binding.region, binding.path,
        binding.request_digest, binding.before_digest, binding.after_digest, from_usize(binding.before_bytes), from_usize(binding.after_bytes)],
        [read.request, read.task, read.operation, read.allowed[0], allowed2, read.files[0], selected2, read.literal, read.outcome, read.result, read.summary],
        [value.task, value.target, value.replacement, value.before, value.after, value.summary],
        [from_i32(state.read.steps), from_i32(state.read.calls), from_i32(state.read.tokens), from_i32(state.read.tools), from_i32(state.read.scan)],
        [from_i32(state.edit.steps), from_i32(state.edit.calls), from_i32(state.edit.tokens), from_i32(state.edit.native_tokens), from_i32(state.edit.boundaries)],
        ["13", "7", "47104", "196608", "1", "4096", "3", "6144", "1", "2048"], remaining];
    var output: Array<string> = []; var index: usize = 0; var size: usize = 0;
    @limits([Iterations(7)]) while index < 7 {
        let encoded = match object(keys[index], values[index]) { Ok(item) => item, Err(error) => { return Err(error); } };
        size = size + char_count(labels[index]) + char_count(encoded) + 1;
        if size > 131072 { return Err("work display exceeds 131072 ASCII bytes"); }
        output = output.push(labels[index] + encoded); index = index + 1;
    }
    return Ok(output);
}

public type LegacyWorkOutput = {};

impl LegacyWorkOutput ~ WorkOutputSink {
    flow progress(self, line: string) -> unit ![Error<IOError>] {
        if line != "POST_EDIT context" && line != "POST_EDIT aggregate" && line != "POST_EDIT events" && line != "POST_EDIT persist" { println(line); }
    }
    flow diagnostic(self, line: string) -> unit ![Error<IOError>] { println(line); }
    flow recorded(self, selected: Selector) -> unit ![Error<IOError>, Error<IndexError>] { recorded(selected); }
    flow ledger(self, state: Ledger, wide: bool, high_input: bool) -> unit ![Error<IOError>] {
        println(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
    }
    flow refused(self, error: string) -> i32 ![Error<IOError>] { println("REFUSED " + error); return 1; }
    flow completed(self, answer: string, saved: string, state: Ledger, wide: bool, high_input: bool) -> i32 ![Error<IOError>, Error<IndexError>] {
        display("FINAL ", answer);
        println(saved);
        println(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
        return 0;
    }
}
