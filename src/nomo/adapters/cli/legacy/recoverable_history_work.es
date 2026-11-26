module nomo.adapters.cli.legacy.recoverable_history_work;

import std.io.{println, IOError as ConsoleError};
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.adapters.cli.arguments.harness_work_args.{parse_recorded, application};
import nomo.adapters.model.harness.history_work_model.HistoryStages;
import nomo.adapters.cli.legacy.harness_work_entry.simple_refused as refused;
import nomo.domain.work.protocol.Summary;
import nomo.session.event_policy.PolicyRoot;
import nomo.adapters.storage.legacy.event_policy.load as load_policy;
import nomo.adapters.storage.legacy.chat_history.load as load_legacy;
import nomo.adapters.storage.legacy.recoverable_chat_store.{load as load_chat, conversation as restore_conversation};
import nomo.domain.sessions.recoverable_work_store.Ticket as WorkTicket;
import nomo.adapters.storage.legacy.recoverable_work_store.{admit, claim, finish as finish_work, abandon as abandon_work, load as load_work};
import nomo.adapters.storage.legacy.recoverable_check_store.{plan as plan_check, load as load_check};
import nomo.adapters.storage.legacy.history_work_guard.inspect as inspect_legacy_work;
import nomo.adapters.storage.legacy.history_check_guard.inspect as inspect_legacy_check;
import nomo.adapters.storage.legacy.history_followup_guard.inspect as inspect_followup;
import nomo.adapters.storage.legacy.history_followup_check_guard.inspect as inspect_followup_check;
import nomo.adapters.storage.legacy.history_followup_edit_store.available as followup_edit_available;
import nomo.domain.sessions.edit_operation_store.Ticket as EditTicket;
import nomo.adapters.storage.legacy.edit_operation_store.{available, begin, complete};
import nomo.core.conversation.Event;
import nomo.session.edit_operation.Binding;
import nomo.domain.sessions.redaction.Policy;
import nomo.adapters.storage.legacy.check_lifecycle.FirstCheck;
import nomo.application.work.controller.execute;
import nomo.adapters.filesystem.work_editor.NativeWorkEditor;
import nomo.adapters.storage.work_timeline.EventWorkTimeline;
import nomo.bootstrap.work.{native_editor, event_timeline};
import nomo.adapters.cli.legacy.terminal_work_output.TerminalWorkOutput;
import nomo.application.work.ports.{WorkPersistence, Run};
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;

type FirstPersistence = { ticket: WorkTicket, redaction: Policy, binding: string };
impl FirstPersistence ~ WorkPersistence<EditTicket, bool> {
    flow begin(self, selected: Binding) -> Result<EditTicket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        match claim(self.ticket, self.redaction, self.binding) { Ok(_) => (), Err(error) => { return Err(error); } }
        return begin(selected);
    }
    flow complete(self, ticket: EditTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return complete(ticket); }
    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        return finish_work(self.ticket, summary.answer, summary.state, records, self.redaction, self.binding);
    }
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<PolicyRoot>, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if args.len() < 2 || args[args.len() - 2] != "--policy-binding" { return refused("event work requires a policy binding"); }
    let binding = args[args.len() - 1];
    let parsed = match parse_recorded(args, 2, false) { Ok(value) => value, Err(error) => { return refused(error); } };
    let cli = parsed.input;
    if cli.edit.help { return refused("select a current read root, owned edit root, target and task"); }
    let input = application(cli);
    let policy = match load_policy() { Ok(value) => value, Err(error) => { return refused(error); } };
    match load_legacy() { Ok(None()) => (), _ => { return refused("legacy session cannot be migrated automatically"); } }
    match inspect_legacy_work() { Ok(None()) => (), _ => { return refused("legacy work exists or is invalid"); } }
    match inspect_legacy_check() { Ok(None()) => (), _ => { return refused("legacy check exists or is invalid"); } }
    match inspect_followup() { Ok(None()) => (), _ => { return refused("legacy followup exists or is invalid"); } }
    match inspect_followup_check() { Ok(None()) => (), _ => { return refused("legacy followup check exists or is invalid"); } }
    match followup_edit_available() { Ok(_) => (), _ => { return refused("legacy followup edit exists or is invalid"); } }
    match available() { Ok(_) => (), Err(error) => { return refused(error); } }
    let history = match load_chat(policy, binding) { Ok(Some(value)) => value, _ => { return refused("saved event chat missing or invalid"); } };
    let conversation = match restore_conversation(history.value.events, history.value.chat.invocation.prior, policy, binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    match load_check(policy, binding) { Ok(None()) => (), _ => { return refused("check already exists or is invalid"); } }
    let ticket = match admit(input.selected.id, input.selected.workspace, input.selected.path, input.request, history, policy, binding) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    match claim(ticket, policy, binding) { Ok(_) => (), Err(error) => { return refused(error); } }
    if parsed.has_check { match plan_check(ticket, parsed.digest, policy, binding) { Ok(_) => (), Err(error) => { return refused(error); } } }
    println("RESERVED event work; interruption or uncertain effects cannot be retried automatically.");
    let prior_request = history.value.chat.last_request; let previous = history.value.chat.invocation.prior;
    let wide = ticket.frame.work.format == 3 || ticket.frame.work.format == 4 || ticket.frame.work.format == 6 || ticket.frame.work.format == 7 || ticket.frame.work.format == 8;
    let high_input = ticket.frame.work.format == 9 || ticket.frame.work.format == 10;
    let stages = HistoryStages { prior_request, previous, conversation, wide = wide || high_input, high_input, historical = false };
    let persistence = FirstPersistence { ticket, redaction = policy, binding };
    return execute<HistoryStages, EditTicket, bool, FirstPersistence, NativeWorkEditor, EventWorkTimeline, TerminalWorkOutput>(stages, persistence, native_editor(), event_timeline(history), TerminalWorkOutput {}, input, Run { redaction = policy, binding, wide = wide || high_input, high_input, saved = "SAVED event work facts; no grant or root identity is persisted." });
}

public flow abandon(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if args.len() != 2 { return refused("recovery requires binding and operation ID"); }
    let policy = match load_policy() { Ok(value) => value, Err(error) => { return refused(error); } };
    let work = match load_work(policy, args[0]) { Ok(Some(value)) => value, _ => { return refused("interrupted work missing"); } };
    let checks = FirstCheck { redaction = policy, binding = args[0] };
    let decision = if work.value.work.phase == "complete" { checks.abandon(args[1]) } else { abandon_work(args[1], policy, args[0]) };
    match decision { Ok(_) => { println("RECORDED user decision: abandoned; interrupted outcome remains unknown; saved budgets are retained."); return 0; } Err(error) => { return refused(error); } }
}
