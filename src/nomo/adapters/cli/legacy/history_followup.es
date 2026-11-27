module nomo.adapters.cli.legacy.history_followup;

import std.io.{println, IOError as ConsoleError};
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.controller.execute;
import nomo.adapters.cli.legacy.edit_coordinator.TerminalPreview;
import nomo.application.work.ports.Run;
import nomo.adapters.storage.work_persistence.FollowupPersistence;
import nomo.adapters.filesystem.legacy_work_editor.LegacyWorkEditor;
import nomo.adapters.storage.legacy_work_timeline.LegacyWorkTimeline;
import nomo.adapters.cli.legacy_work_output.LegacyWorkOutput;
import nomo.adapters.cli.arguments.harness_work_args.{parse_recorded, application};
import nomo.adapters.model.harness.history_followup_model.HistoryStages;
import nomo.domain.harness.history_followup_model.PriorWork;
import nomo.domain.sessions.facts.CheckOutput;
import nomo.adapters.storage.legacy.chat_history.load as load_chat;
import nomo.adapters.storage.legacy.check_output.load as load_check_output;
import nomo.adapters.storage.legacy.edit_operation_store.FollowupEditJournal;
import nomo.domain.sessions.edit_operation_store.Ticket as EditTicket;
import nomo.adapters.storage.legacy.history_check_guard.inspect as inspect_first_check;
import nomo.adapters.storage.legacy.history_followup_guard.{admit, claim};
import nomo.adapters.storage.legacy.history_followup_check_guard.plan as plan_check;
import nomo.domain.sessions.redaction.Policy;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;

flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>, Error<BudgetExceeded>] {
    let parsed = match parse_recorded(args, 0, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    let cli = parsed.input;
    if cli.edit.help { return refused("select a current read root, owned edit root, target and task"); }
    let input = application(cli);
    let journal = FollowupEditJournal {};
    match journal.available() { Ok(_) => (), Err(error) => { return refused(error); } }
    let history = match load_chat() { Ok(Some(value)) => value, _ => { return refused("a saved prior chat turn is required"); } };
    let first_check = match inspect_first_check() { Ok(value) => value, Err(error) => { return refused(error); } };
    var first_output: Option<CheckOutput> = None();
    match first_check {
        Some(value) => {
            if value.phase != "complete" { return refused("first check outcome unresolved"); }
            let saved = match load_check_output("first", value.id, value.digest) { Ok(found) => found, Err(error) => { return refused(error); } };
            match saved {
                Some(found) => { first_output = Some(CheckOutput { stdout = found.stdout, stderr = found.stderr,
                    stdout_truncated = found.stdout_truncated, stderr_truncated = found.stderr_truncated }); }
                None() => (),
            }
        }
        None() => (),
    }
    let ticket = match admit(input.selected.id, input.selected.workspace, input.selected.path, input.request, history) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    if ticket.record.parent.check != first_check { return refused("first check changed before followup; no retry"); }
    match claim(ticket) { Ok(_) => (), Err(error) => { return refused(error); } }
    if parsed.has_check { match plan_check(ticket, parsed.digest) { Ok(_) => (), Err(error) => { return refused(error); } } }
    println("RESERVED history-followup; failure or interruption cannot be retried automatically.");
    let checked = match ticket.record.parent.check { Some(value) => value.outcome, None() => "not requested" };
    let exit = match ticket.record.parent.check { Some(value) => value.exit_code, None() => "" };
    let prior_work = PriorWork { request = ticket.record.parent.work.request, summary = ticket.record.parent.work.summary,
        summary_source = "unknown", selection = None(), check = checked, exit_code = exit, output = first_output, history = [] };
    let stages = HistoryStages { prior_request = history.value.last_request, previous = history.value.invocation.prior,
        conversation = [], prior_work, wide = false, high_input = false, historical = true };
    let persistence = FollowupPersistence { ticket, journal };
    let run = Run { redaction = Policy { format = 1, literals = [] }, binding = "", wide = false, high_input = false,
        saved = "SAVED history-followup; captured history is not a root identity or grant." };
    return execute<HistoryStages, EditTicket, bool, FollowupPersistence, LegacyWorkEditor, TerminalPreview, LegacyWorkTimeline, LegacyWorkOutput>(
        stages, persistence, LegacyWorkEditor {}, TerminalPreview {}, LegacyWorkTimeline {}, LegacyWorkOutput {}, input, run);
}
