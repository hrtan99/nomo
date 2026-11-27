module nomo.adapters.cli.legacy.edit_coordinator;

import std.io.{println, read_line, IOError as ConsoleError};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.{trim, lowercase, char_count as len};
import nomo.tools.edit_file.EditableRoot;
import nomo.domain.mutations.edit_contract.Prepared;
import nomo.adapters.filesystem.legacy.edit_file.apply;
import nomo.session.edit_operation.Binding;
import nomo.adapters.storage.legacy.edit_operation_store.{begin, complete};
public import nomo.application.edit.effects.Approval;
public import nomo.domain.mutations.edit_contract.{Selector, Confirmed};

public import nomo.application.edit.ports.{Preview, PreviewPresenter, CurrentEditConsent};
public import nomo.application.edit.confirmation.{build_preview, confirm_using};
import nomo.application.work.ports.WorkConfirmation;

public type TerminalPreview = {};
public type TerminalConsent = {};

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
impl TerminalPreview ~ WorkConfirmation {
    flow confirm(self, selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<IndexError>, Error<ConsoleError>, Error<BudgetExceeded>] {
        return confirm_using(self, TerminalConsent {}, selector, prepared);
    }
}

public flow confirm_current(selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<IndexError>, Error<ConsoleError>, Error<BudgetExceeded>] {
    return TerminalPreview {}.confirm(selector, prepared);
}

public flow execute(selector: Selector, prepared: Prepared) -> Result<Confirmed, string> ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>, Error<BudgetExceeded>] {
    let selected = match confirm_current(selector, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    let ticket = match begin(selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    println("INTENT durable " + selector.id);
    match apply(prepared) { Ok(_) => (), Err(error) => { return Err(error); } }
    match complete(ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    println("APPLIED " + selector.id);
    return Ok(Confirmed { binding = selected, after = prepared.proposal.after });
}
