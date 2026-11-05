module nomo.entry.history_work;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.controller.execute;
import nomo.application.work.request.WorkRequest;
import nomo.application.work.ports.{WorkStages, WorkPersistence, Pending, Failure, Completed, Summary, Run};
import nomo.bootstrap.legacy_work.{LegacyWorkEditor, LegacyWorkTimeline, LegacyWorkOutput, legacy_editor, legacy_timeline, legacy_output};
import nomo.cli.harness_work_args.{parse_recorded, application};
import nomo.core.conversation.Event;
import nomo.harness.history_work_model.HistoryStages;
import nomo.harness.history_stages.{prepare_legacy, summarize_legacy};
import nomo.session.chat_history.load as load_chat;
import nomo.session.edit_operation.Binding;
import nomo.session.edit_operation_store.{EditJournal, FirstEditJournal, Ticket as EditTicket};
import nomo.session.history_work_guard.{Ticket as WorkTicket, admit, claim, finish};
import nomo.session.history_check_guard.plan as plan_check;
import nomo.session.redaction.Policy;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;

flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

type LegacyStages = { model: HistoryStages };
impl LegacyStages ~ WorkStages {
    flow prepare(self, input: WorkRequest) -> Result<Pending, Failure> { return prepare_legacy(self.model, input); }
    flow summarize(self, value: Completed) -> Result<Summary, Failure> { return summarize_legacy(self.model, value); }
}

type FirstPersistence = { ticket: WorkTicket, journal: FirstEditJournal };
impl FirstPersistence ~ WorkPersistence<EditTicket, bool> {
    flow begin(self, selected: Binding) -> Result<EditTicket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        match claim(self.ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
        return self.journal.begin(selected);
    }
    flow complete(self, ticket: EditTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        return self.journal.complete(ticket);
    }
    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        return finish(self.ticket, summary.answer, summary.state);
    }
}

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let parsed = match parse_recorded(args, 0, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    let cli = parsed.input;
    if cli.edit.help { return refused("select a current read root, owned edit root, target and task"); }
    let input = application(cli);
    let journal = FirstEditJournal {};
    match journal.available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let history = match load_chat() { Ok(Some(value)) => value, _ => { return refused("a saved prior chat turn is required"); } };
    let ticket = match admit(input.selected.id, input.selected.workspace, input.selected.path, input.request, history) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    match claim(ticket) { Ok(_) => {} Err(error) => { return refused(error); } }
    if parsed.has_check { match plan_check(ticket, parsed.digest) { Ok(_) => {} Err(error) => { return refused(error); } } }
    println("RESERVED history-work; failure or interruption cannot be retried automatically.");
    let model = HistoryStages { prior_request = history.value.last_request, previous = history.value.invocation.prior, wide = false };
    let stages = LegacyStages { model = model };
    let persistence = FirstPersistence { ticket = ticket, journal = journal };
    let run = Run { redaction = Policy { format = 1, literals = [] }, binding = "", wide = false,
        saved = "SAVED history-work; captured history is not a root identity or grant." };
    return execute<LegacyStages, EditTicket, bool, FirstPersistence, LegacyWorkEditor, LegacyWorkTimeline, LegacyWorkOutput>(
        stages, persistence, legacy_editor(), legacy_timeline(), legacy_output(), input, run);
}
