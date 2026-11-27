module nomo.application.edit.execute;

import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.edit.effects.Approval;
import nomo.application.sessions.ports.session_edit_operation_store.EditJournal;
import nomo.application.work.ports.{WorkEditor, WorkConfirmation};
import nomo.application.work.output.WorkOutputSink;
import nomo.domain.mutations.edit_contract.{Selector, Prepared, Confirmed};
import nomo.tools.edit_file.EditableRoot;

public flow execute<E ~ WorkEditor, J ~ EditJournal, C ~ WorkConfirmation, O ~ WorkOutputSink>(files: E, journal: J, consent: C, output: O, selector: Selector, prepared: Prepared) -> Result<Confirmed, string> ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>, Error<BudgetExceeded>] {
    let selected = match consent.confirm(selector, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    let ticket = match journal.begin(selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    output.progress("INTENT durable " + selector.id);
    match files.apply(prepared) { Ok(_) => (), Err(error) => { return Err(error); } }
    match journal.complete(ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    output.progress("APPLIED " + selector.id);
    return Ok(Confirmed { binding = selected, after = prepared.proposal.after });
}
