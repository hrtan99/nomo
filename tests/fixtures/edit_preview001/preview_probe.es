module app.preview_probe;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.split;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.domain.mutations.edit_diff.render;
import nomo.domain.sessions.session_display.ascii_json_with;
import nomo.tools.edit_file.{EditableRoot};
import nomo.domain.mutations.edit_contract.{prepare_original};
import nomo.domain.mutations.edit_contract.{Selector};
import nomo.application.edit.effects.{Approval};
import nomo.application.edit.execute.execute;
import nomo.application.edit.confirmation.build_preview;
import nomo.application.work.ports.WorkConfirmation;
import nomo.domain.mutations.edit_contract.Prepared;
import nomo.session.edit_operation.Binding;
import nomo.adapters.cli.legacy.edit_coordinator.TerminalPreview;
import nomo.adapters.filesystem.legacy_work_editor.LegacyWorkEditor;
import nomo.adapters.storage.legacy.edit_operation_store.FirstEditJournal;
import nomo.adapters.cli.legacy_work_output.LegacyWorkOutput;

type Check = { label: string, before: string, after: string, expected: string, error: string };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }

flow terminal_safe(value: string) -> bool {
    let bytes = utf8_encode(value);
    if byte_count(bytes) > 8192 { return false; }
    var index: usize = 0;
    @limits([Iterations(8192)]) while index < byte_count(bytes) {
        let number = bytes[index];
        if number != 10 && (number < 32 || number > 126) { return false; }
        index = index + 1;
    }
    return true;
}

flow evaluate(item: Check) -> bool {
    return match render(item.before, item.after) {
        Ok(value) => item.error == "" && value == item.expected && terminal_safe(value),
        Err(error) => item.error != "" && error == item.error,
    };
}

public flow pure_probe() -> bool {
    @limits([Iterations(32)]) for item in checks() { if !evaluate(item) { return false; } }
    let control = match char.from_u32(127) { Some(value) => std.text.from_char(value), None() => { return false; } };
    match ascii_json_with("\"" + control + "\"", 16, 16, "encoded", "display") {
        Ok(value) => { if value != "\"" + slash() + "u007f\"" { return false; } },
        Err(_) => { return false; }
    }
    return true;
}

public flow observe(args: Array<string>) -> i32 {
    @limits([Iterations(32)]) for item in checks() {
        if !evaluate(item) { println("FAIL " + item.label); abort("edit preview golden failed"); }
        println("PASS " + item.label);
    }
    return 0;
}

type DeniedConfirmation = {};
impl DeniedConfirmation ~ WorkConfirmation {
    flow confirm(self, selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<IndexError>, Error<ConsoleError>, Error<BudgetExceeded>] {
        let shown = match build_preview(selector, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
        TerminalPreview {}.present(shown);
        println("SOURCE_APPROVAL_DENIED Nomo edit " + shown.binding.id + " request=" + shown.binding.request_digest);
        return Err("native approval denied; no intent or File write");
    }
}

// A substituted confirmation port, not a native approval exercise. The real
// application controller returns before its journal/File branches.
public flow denied(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>, Error<BudgetExceeded>] {
    let prepared = match prepare_original("docs/说明.txt", "head\n前😀 old\nend\n", "old", "新😀") {
        Ok(value) => value, Err(error) => abort(error),
    };
    let selector = Selector { id = "preview-denied", workspace = "preview-fixture", path = "docs/说明.txt" };
    let answer = execute(LegacyWorkEditor {}, FirstEditJournal {}, DeniedConfirmation {}, LegacyWorkOutput {}, selector, prepared);
    match answer {
        Err(error) => { if error != "native approval denied; no intent or File write" { abort(error); } },
        Ok(_) => abort("source denial unexpectedly completed edit"),
    }
    println("PASS source denial preserves preview and stops before journal");
    return 0;
}
