module nomo.adapters.cli.legacy.recoverable_history_followup;

import nomo.domain.sessions.work_fact_events.{summary_source, selection};
import nomo.adapters.storage.legacy.recoverable_work_facts.snapshot as work_snapshot;
import nomo.domain.sessions.facts.{WorkFacts, CheckOutput};
import std.io.{println, IOError as ConsoleError};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.memory.MemoryEntry;
import nomo.adapters.cli.arguments.harness_work_args.{parse_recorded, application};
import nomo.application.work.request.WorkRequest;
import nomo.adapters.model.harness.history_followup_model.HistoryStages;
import nomo.domain.harness.history_followup_model.{PriorWork, HistoryWork};
import nomo.session.event_policy.PolicyRoot;
import nomo.adapters.storage.legacy.event_policy.load as load_policy;
import nomo.adapters.storage.legacy.recoverable_check_store.load as inspect_first_check;
import nomo.adapters.storage.legacy.recoverable_work_store.load as inspect_first_work;
import nomo.domain.sessions.event_text_codec.decode;
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.adapters.cli.legacy.harness_work_entry.simple_refused as refused;
import nomo.domain.work.protocol.Summary;
import nomo.session.recoverable_chat_store.Frame as ChatFrame;
import nomo.adapters.storage.legacy.recoverable_chat_store.{load as load_chat, conversation as restore_conversation};
import nomo.domain.sessions.recoverable_followup_store.Ticket as WorkTicket;
import nomo.adapters.storage.legacy.recoverable_followup_store.{admit, claim, finish as finish_work, abandon as abandon_followup, load as load_followup};
import nomo.domain.sessions.continuous_work.Stored;
import nomo.adapters.storage.legacy.continuous_work.{load as load_extra, admit as admit_extra, edit_intent, edit_complete, finish as finish_extra, abandon as abandon_extra, abandon_check as abandon_extra_check};
import nomo.domain.sessions.redaction.Policy;
import nomo.adapters.storage.legacy.recoverable_followup_check_store.{plan as plan_check, load as load_followup_check, abandon as abandon_followup_check};
import nomo.domain.sessions.edit_operation_store.Ticket as EditTicket;
import nomo.adapters.storage.legacy.history_followup_edit_store.{available, begin, complete};
import nomo.core.conversation.Event;
import nomo.session.edit_operation.Binding;
import nomo.application.work.controller.execute;
import nomo.adapters.filesystem.work_editor.NativeWorkEditor;
import nomo.adapters.storage.work_timeline.EventWorkTimeline;
import nomo.bootstrap.work.{native_editor, event_timeline};
import nomo.adapters.cli.legacy.terminal_work_output.TerminalWorkOutput;
import nomo.application.work.ports.{WorkPersistence, Run};
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;

type FollowupPersistence = { ticket: WorkTicket, redaction: Policy, binding: string };
impl FollowupPersistence ~ WorkPersistence<EditTicket, bool> {
    flow begin(self, selected: Binding) -> Result<EditTicket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        match claim(self.ticket, self.redaction, self.binding) { Ok(_) => (), Err(error) => { return Err(error); } }
        return begin(selected);
    }
    flow complete(self, ticket: EditTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return complete(ticket); }
    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return finish_work(self.ticket, summary.answer, summary.state, records, self.redaction, self.binding); }
}
type ContinuousPersistence = { ticket: Stored, redaction: Policy };
impl ContinuousPersistence ~ WorkPersistence<Stored, Stored> {
    flow begin(self, selected: Binding) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] { return edit_intent(self.ticket, selected); }
    flow complete(self, ticket: Stored) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] { return edit_complete(ticket); }
    flow finish(self, edited: Stored, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        return match finish_extra(edited, summary.answer, if summary.model_generated { "model" } else { "system" }, summary.state, records, self.redaction) { Ok(_) => Ok(true), Err(error) => Err(error) };
    }
}

flow historical(value: WorkFacts) -> HistoryWork {
    return HistoryWork { id = value.id, summary = value.summary, summary_source = value.summary_source, selection = value.selection, check = value.check, exit_code = value.exit_code };
}

// Subsequent operations use a single durable append-only book. Earlier fixed
// work/check records remain in place and continue to provide session history.
flow more(input: WorkRequest, prior_request: string, previous: Previous, conversation: Array<Event>, chat: MemoryEntry<string, ChatFrame>, first_id: string, check_digest: string, policy: Policy, binding: string, wide: bool, high_input: bool) -> i32 {
    let second = match load_followup(policy, binding) { Ok(Some(value)) => value, _ => { return refused("completed followup required"); } };
    let work = second.value.work;
    if input.selected.id == first_id || input.selected.id == work.id { return refused("distinct work ID required"); }
    let facts = match work_snapshot(policy, binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    var latest = match facts.followup { Some(value) => value, None() => { return refused("followup facts missing"); } };
    var request = work.request; var history: Array<HistoryWork> = [];
    match facts.first { Some(value) => { history = history.push(historical(value)); } None() => (), }
    history = history.push(historical(latest));
    @limits([Iterations(48)]) for value in facts.additional { history = history.push(historical(value)); latest = value; }
    let extra = match load_extra(binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    match extra { Some(value) => { request = value.value.current.core.request; } None() => (), }
    let prior = PriorWork { request, summary = latest.summary, summary_source = latest.summary_source, selection = latest.selection, check = latest.check, exit_code = latest.exit_code, output = latest.output, history };
    let ticket = match admit_extra(binding, input.selected.id, input.selected.workspace, input.selected.path, input.request, check_digest, policy, wide, high_input) { Ok(value) => value, Err(error) => { return refused(error); } };
    println(if high_input { "RESERVED high-input additional work: 7 calls, 917504 output tokens, 7340032 configured native tokens; interruption leaves this work unresolved." } else { if wide { "RESERVED additional work: 7 calls, 286720 output tokens, 2811008 configured native tokens; interruption leaves this work unresolved." } else { "RESERVED additional work: 7 calls, 51200 output tokens, 1335296 configured native tokens; interruption leaves this work unresolved." } });
    let stages = HistoryStages { prior_request, previous, conversation, prior_work = prior, wide, high_input, historical = false };
    let persistence = ContinuousPersistence { ticket, redaction = policy };
    return execute<HistoryStages, Stored, Stored, ContinuousPersistence, NativeWorkEditor, EventWorkTimeline, TerminalWorkOutput>(stages, persistence, native_editor(), event_timeline(chat), TerminalWorkOutput {}, input, Run { redaction = policy, binding, wide, high_input, saved = "SAVED additional work facts" });
}

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<PolicyRoot>, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if args.len() < 2 || args[args.len() - 2] != "--policy-binding" { return refused("event followup requires policy binding"); }
    let binding = args[args.len() - 1];
    let parsed = match parse_recorded(args, 2, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    let cli = parsed.input;
    if cli.edit.help { return refused("select a current read root, owned edit root, target and task"); }
    let input = application(cli);
    let policy = match load_policy() { Ok(item) => item, Err(error) => { return refused(error); } };
    let history = match load_chat(policy, binding) { Ok(Some(value)) => value, _ => { return refused("saved event chat required"); } };
    let conversation = match restore_conversation(history.value.events, history.value.chat.invocation.prior, policy, binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    if history.value.chat.phase == "running" { return refused("chat turn unresolved"); }
    let first_work = match inspect_first_work(policy, binding) { Ok(Some(value)) => value, _ => { return refused("completed first work required"); } };
    if first_work.value.work.phase != "complete" && first_work.value.work.phase != "abandoned" { return refused("first work unresolved"); }
    match load_followup(policy, binding) {
        Ok(Some(_)) => { return more(input, history.value.chat.last_request, history.value.chat.invocation.prior, conversation, history, first_work.value.work.id, parsed.digest, policy, binding, history.value.chat.format >= 13, history.value.chat.format == 18 || history.value.chat.format == 19); }
        Ok(None()) => (),
        Err(error) => { return refused(error); }
    }
    match available() { Ok(_) => (), Err(error) => { return refused(error); } }
    let first_check = match inspect_first_check(policy, binding) { Ok(value) => value, Err(error) => { return refused(error); } };
    var first_output: Option<CheckOutput> = None(); var checked = "not requested"; var exit = "";
    match first_check {
        Some(value) => if value.value.check.phase == "abandoned" { checked = "abandoned; outcome unknown"; } else if first_work.value.work.phase == "abandoned" && value.value.check.phase == "planned" { checked = "not started after abandoned work"; } else {
        if value.value.check.phase != "complete" { return refused("first check outcome unresolved"); }
        let out = match decode(value.value.stdout, policy) { Ok(item) => item, Err(error) => { return refused(error); } };
        let err = match decode(value.value.stderr, policy) { Ok(item) => item, Err(error) => { return refused(error); } };
        first_output = Some(CheckOutput { stdout = out, stderr = err, stdout_truncated = value.value.stdout_truncated, stderr_truncated = value.value.stderr_truncated });
        checked = value.value.check.outcome; exit = value.value.check.exit_code;
        },
        None() => (),
    }
    match load_followup_check(policy, binding) { Ok(None()) => (), _ => { return refused("followup check exists or is invalid"); } }
    let origin = match summary_source(first_work.value.events, first_work.value.work.summary, policy) { Ok(value) => value, Err(error) => { return refused(error); } };
    let chosen = match selection(first_work.value.events.events, policy) { Ok(value) => value, Err(error) => { return refused(error); } };
    let ticket = match admit(input.selected.id, input.selected.workspace, input.selected.path, input.request, history, policy, binding) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    if ticket.frame.parent_work_version != first_work.version.opaque { return refused("first work changed before followup"); }
    match first_check { Some(value) => { if ticket.frame.parent_check_version != value.version.opaque { return refused("first check changed before followup"); } }, None() => { if ticket.frame.parent_check_version != "" { return refused("first check changed before followup"); } }, }
    match claim(ticket, policy, binding) { Ok(_) => (), Err(error) => { return refused(error); } }
    if parsed.has_check { match plan_check(ticket, parsed.digest, policy, binding) { Ok(_) => (), Err(error) => { return refused(error); } } }
    println("RESERVED event followup; interruption or uncertain effects cannot be retried automatically.");
    let prior_request = history.value.chat.last_request; let previous = history.value.chat.invocation.prior;
    let prior_work = PriorWork { request = first_work.value.work.request, summary = if first_work.value.work.phase == "abandoned" { "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit." } else { first_work.value.work.summary }, summary_source = if first_work.value.work.phase == "abandoned" { "system" } else { origin }, selection = chosen, check = checked, exit_code = exit, output = first_output, history = [] };
    let wide = ticket.frame.work.format == 3 || ticket.frame.work.format == 4 || ticket.frame.work.format == 6 || ticket.frame.work.format == 7 || ticket.frame.work.format == 8;
    let high_input = ticket.frame.work.format == 9 || ticket.frame.work.format == 10;
    let stages = HistoryStages { prior_request, previous, conversation, prior_work, wide = wide || high_input, high_input, historical = false };
    let persistence = FollowupPersistence { ticket, redaction = policy, binding };
    return execute<HistoryStages, EditTicket, bool, FollowupPersistence, NativeWorkEditor, EventWorkTimeline, TerminalWorkOutput>(stages, persistence, native_editor(), event_timeline(history), TerminalWorkOutput {}, input, Run { redaction = policy, binding, wide = wide || high_input, high_input, saved = "SAVED event followup facts; no grant or root identity is persisted." });
}

public flow abandon(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if args.len() != 2 { return refused("recovery requires binding and operation ID"); }
    let policy = match load_policy() { Ok(value) => value, Err(error) => { return refused(error); } };
    let extra = match load_extra(args[0]) { Ok(value) => value, Err(error) => { return refused(error); } };
    let result = match extra {
        Some(item) => if item.value.current.result.phase == "complete" { abandon_extra_check(args[0], args[1]) } else { abandon_extra(args[0], args[1]) },
        None() => { let work = match load_followup(policy, args[0]) { Ok(Some(value)) => value, _ => { return refused("interrupted followup missing"); } }; if work.value.work.phase == "complete" { abandon_followup_check(args[1], policy, args[0]) } else { abandon_followup(args[1], policy, args[0]) } },
    };
    return match result { Ok(_) => { println("RECORDED user decision: abandoned; interrupted outcome remains unknown; saved budgets are retained."); 0 } Err(error) => refused(error) };
}
