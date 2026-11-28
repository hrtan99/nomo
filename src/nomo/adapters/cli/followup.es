module nomo.adapters.cli.followup;

import nomo.adapters.cli.console.{TerminalWorkOutput, simple_refused};
import nomo.adapters.cli.edit_input.{application, parse_recorded};
import nomo.adapters.cli.editing.{LegacyWorkOutput, TerminalPreview};
import nomo.adapters.filesystem.editing.{LegacyWorkEditor, NativeWorkEditor};
import nomo.adapters.storage.chat.{chat_history_load, conversation as chat_conversation, recoverable_chat_store_load};
import nomo.adapters.storage.check_lifecycle.load;
import nomo.adapters.storage.checks.{inspect, load as checks_load};
import nomo.adapters.storage.edits.{FollowupEditJournal, history_followup_edit_store_available};
import nomo.adapters.storage.followup.{
    FollowupPersistence,
    RecoverableFollowupPersistence,
    abandon as followup_abandon,
    historical_followup_admit,
    historical_followup_claim,
    load as followup_load,
    recoverable_followup_store_admit,
    recoverable_followup_store_claim
};
import nomo.adapters.storage.followup_checks.{
    abandon as followup_checks_abandon,
    history_followup_check_guard_plan,
    load as followup_checks_load,
    recoverable_followup_check_store_plan
};
import nomo.adapters.storage.session_records.event_policy_load;
import nomo.adapters.storage.work_admission.{
    ContinuousPersistence,
    Stored,
    abandon_check,
    continuous_work_abandon,
    continuous_work_admit,
    continuous_work_load,
    recoverable_work_store_load
};
import nomo.adapters.storage.work_history.{EventWorkTimeline, LegacyWorkTimeline, snapshot};
import nomo.application.editing.ports.{Run, Ticket};
import nomo.application.editing.workflow.work_controller_execute;
import nomo.bootstrap.work.{HistoryFollowupStages, HistoryWork, PriorWork};
import nomo.core.conversation.Event;
import nomo.domain.sessions.event_codec.{Policy, event_text_codec_decode};
import nomo.domain.sessions.work.{CheckOutput, WorkFacts, WorkRequest, selection, summary_source};
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.session.event_policy.PolicyRoot;
import nomo.session.recoverable_chat_store.Frame;
import nomo.tools.edit_file.EditableRoot;
import nomo.tools.workspace.ReadOnlyRoot;
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println};
import std.memory.MemoryEntry;

flow refused(error: string) -> i32 {
    println("REFUSED " + error);
    return 1;
}

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow history_followup_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Approval,
    Fs.read<ReadOnlyRoot>,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let parsed = match parse_recorded(args, 0, true) {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    let cli = parsed.input;
    if cli.edit.help {
        return refused("select a current read root, owned edit root, target and task");
    }
    let input = application(cli);
    let journal = FollowupEditJournal {};
    match journal.available() {
        Ok(_) => (),
        Err(error) => {
            return refused(error);
        }
    }
    let history = match chat_history_load() {
        Ok(Some(value)) => value,
        _ => {
            return refused("a saved prior chat turn is required");
        }
    };
    let first_check = match inspect() {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    var first_output: Option<CheckOutput> = None();
    match first_check {
        Some(value) => {
            if value.phase != "complete" {
                return refused("first check outcome unresolved");
            }
            let saved = match load("first", value.id, value.digest) {
                Ok(found) => found,
                Err(error) => {
                    return refused(error);
                }
            };
            match saved {
                Some(found) => {
                    first_output = Some(
                        CheckOutput {
                            stdout = found.stdout,
                            stderr = found.stderr,
                            stdout_truncated = found.stdout_truncated,
                            stderr_truncated = found.stderr_truncated
                        }
                    );
                }
                None() => (),
            }
        }
        None() => (),
    }
    let ticket = match historical_followup_admit(
        input.selected.id,
        input.selected.workspace,
        input.selected.path,
        input.request,
        history
    ) {
        Ok(value) => value,
        Err(error) => {
            return refused(error);
        }
    };
    if ticket.record.parent.check != first_check {
        return refused("first check changed before followup; no retry");
    }
    match historical_followup_claim(ticket) {
        Ok(_) => (),
        Err(error) => {
            return refused(error);
        }
    }
    if parsed.has_check {
        match history_followup_check_guard_plan(ticket, parsed.digest) {
            Ok(_) => (),
            Err(error) => {
                return refused(error);
            }
        }
    }
    println("RESERVED history-followup; failure or interruption cannot be retried automatically.");
    let checked = match ticket.record.parent.check {
        Some(value) => value.outcome,
        None() => "not requested"
    };
    let exit = match ticket.record.parent.check {
        Some(value) => value.exit_code,
        None() => ""
    };
    let prior_work = PriorWork {
        request = ticket.record.parent.work.request,
        summary = ticket.record.parent.work.summary,
        summary_source = "unknown",
        selection = None(),
        check = checked,
        exit_code = exit,
        output = first_output,
        history = []
    };
    let stages = HistoryFollowupStages {
        prior_request = history.value.last_request,
        previous = history.value.invocation.prior,
        conversation = [],
        prior_work,
        wide = false,
        high_input = false,
        historical = true
    };
    let persistence = FollowupPersistence {
        ticket,
        journal
    };
    let run = Run {
        redaction = Policy {
            format = 1,
            literals = []
        },
        binding = "",
        wide = false,
        high_input = false,
        saved = "SAVED history-followup; captured history is not a root identity or grant."
    };
    return work_controller_execute<
        HistoryFollowupStages,
        Ticket,
        bool,
        FollowupPersistence,
        LegacyWorkEditor,
        TerminalPreview,
        LegacyWorkTimeline,
        LegacyWorkOutput
    >(
        stages,
        persistence,
        LegacyWorkEditor {},
        TerminalPreview {},
        LegacyWorkTimeline {},
        LegacyWorkOutput {},
        input,
        run
    );
}

flow historical(value: WorkFacts) -> HistoryWork {
    return HistoryWork {
        id = value.id,
        summary = value.summary,
        summary_source = value.summary_source,
        selection = value.selection,
        check = value.check,
        exit_code = value.exit_code
    };
}

// Subsequent operations use a single durable append-only book. Earlier fixed
// work/check records remain in place and continue to provide session history.
flow more(
    input: WorkRequest,
    prior_request: string,
    previous: Previous,
    conversation: Array<Event>,
    chat: MemoryEntry<string, Frame>,
    first_id: string,
    check_digest: string,
    policy: Policy,
    binding: string,
    wide: bool,
    high_input: bool
) -> i32 {
    let second = match followup_load(policy, binding) {
        Ok(Some(value)) => value,
        _ => {
            return simple_refused("completed followup required");
        }
    };
    let work = second.value.work;
    if input.selected.id == first_id || input.selected.id == work.id {
        return simple_refused("distinct work ID required");
    }
    let facts = match snapshot(policy, binding) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    var latest = match facts.followup {
        Some(value) => value,
        None() => {
            return simple_refused("followup facts missing");
        }
    };
    var request = work.request;
    var history: Array<HistoryWork> = [];
    match facts.first {
        Some(value) => {
            history = history.push(historical(value));
        }
        None() => (),
    }
    history = history.push(historical(latest));
    history = history.extend(facts.additional.iter().map(value => historical(value)).collect());
    latest = match facts.additional.iter().last() {
        Some(value) => value,
        None() => latest
    };
    let extra = match continuous_work_load(binding) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    match extra {
        Some(value) => {
            request = value.value.current.core.request;
        }
        None() => (),
    }
    let prior = PriorWork {
        request,
        summary = latest.summary,
        summary_source = latest.summary_source,
        selection = latest.selection,
        check = latest.check,
        exit_code = latest.exit_code,
        output = latest.output,
        history
    };
    let ticket = match continuous_work_admit(
        binding,
        input.selected.id,
        input.selected.workspace,
        input.selected.path,
        input.request,
        check_digest,
        policy,
        wide,
        high_input
    ) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    println(if high_input {
        "RESERVED high-input additional work: 7 calls, 917504 output tokens, 7340032 configured native tokens; interruption leaves this work unresolved."
    } else {
        if wide {
            "RESERVED additional work: 7 calls, 286720 output tokens, 2811008 configured native tokens; interruption leaves this work unresolved."
        } else {
            "RESERVED additional work: 7 calls, 51200 output tokens, 1335296 configured native tokens; interruption leaves this work unresolved."
        }
    });
    let stages = HistoryFollowupStages {
        prior_request,
        previous,
        conversation,
        prior_work = prior,
        wide,
        high_input,
        historical = false
    };
    let persistence = ContinuousPersistence {
        ticket,
        redaction = policy
    };
    return work_controller_execute<
        HistoryFollowupStages,
        Stored,
        Stored,
        ContinuousPersistence,
        NativeWorkEditor,
        TerminalPreview,
        EventWorkTimeline,
        TerminalWorkOutput
    >(
        stages,
        persistence,
        NativeWorkEditor {},
        TerminalPreview {},
        EventWorkTimeline {
            chat
        },
        TerminalWorkOutput {},
        input,
        Run {
            redaction = policy,
            binding,
            wide,
            high_input,
            saved = "SAVED additional work facts"
        }
    );
}

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow recoverable_history_followup_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Approval,
    Fs.read<PolicyRoot>,
    Fs.read<ReadOnlyRoot>,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    if args.len() < 2 || args[args.len() - 2] != "--policy-binding" {
        return simple_refused("event followup requires policy binding");
    }
    let binding = args[args.len() - 1];
    let parsed = match parse_recorded(args, 2, true) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    let cli = parsed.input;
    if cli.edit.help {
        return simple_refused("select a current read root, owned edit root, target and task");
    }
    let input = application(cli);
    let policy = match event_policy_load() {
        Ok(item) => item,
        Err(error) => {
            return simple_refused(error);
        }
    };
    let history = match recoverable_chat_store_load(policy, binding) {
        Ok(Some(value)) => value,
        _ => {
            return simple_refused("saved event chat required");
        }
    };
    let conversation = match chat_conversation(
        history.value.events,
        history.value.chat.invocation.prior,
        policy,
        binding
    ) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    if history.value.chat.phase == "running" {
        return simple_refused("chat turn unresolved");
    }
    let first_work = match recoverable_work_store_load(policy, binding) {
        Ok(Some(value)) => value,
        _ => {
            return simple_refused("completed first work required");
        }
    };
    if first_work.value.work.phase != "complete" && first_work.value.work.phase != "abandoned" {
        return simple_refused("first work unresolved");
    }
    match followup_load(policy, binding) {
        Ok(Some(_)) => {
            return more(
                input,
                history.value.chat.last_request,
                history.value.chat.invocation.prior,
                conversation,
                history,
                first_work.value.work.id,
                parsed.digest,
                policy,
                binding,
                history.value.chat.format >= 13,
                history.value.chat.format == 18 || history.value.chat.format == 19
            );
        }
        Ok(None()) => (),
        Err(error) => {
            return simple_refused(error);
        }
    }
    match history_followup_edit_store_available() {
        Ok(_) => (),
        Err(error) => {
            return simple_refused(error);
        }
    }
    let first_check = match checks_load(policy, binding) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    var first_output: Option<CheckOutput> = None();
    var checked = "not requested";
    var exit = "";
    match first_check {
        Some(value) => if value.value.check.phase == "abandoned" {
            checked = "abandoned; outcome unknown";
        } else if first_work.value.work.phase == "abandoned" && value.value.check.phase == "planned" {
            checked = "not started after abandoned work";
        } else {
            if value.value.check.phase != "complete" {
                return simple_refused("first check outcome unresolved");
            }
            let out = match event_text_codec_decode(value.value.stdout, policy) {
                Ok(item) => item,
                Err(error) => {
                    return simple_refused(error);
                }
            };
            let err = match event_text_codec_decode(value.value.stderr, policy) {
                Ok(item) => item,
                Err(error) => {
                    return simple_refused(error);
                }
            };
            first_output = Some(
                CheckOutput {
                    stdout = out,
                    stderr = err,
                    stdout_truncated = value.value.stdout_truncated,
                    stderr_truncated = value.value.stderr_truncated
                }
            );
            checked = value.value.check.outcome;
            exit = value.value.check.exit_code;
        },
        None() => (),
    }
    match followup_checks_load(policy, binding) {
        Ok(None()) => (),
        _ => {
            return simple_refused("followup check exists or is invalid");
        }
    }
    let origin = match summary_source(first_work.value.events, first_work.value.work.summary, policy) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    let chosen = match selection(first_work.value.events.events, policy) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    let ticket = match recoverable_followup_store_admit(
        input.selected.id,
        input.selected.workspace,
        input.selected.path,
        input.request,
        history,
        policy,
        binding
    ) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    if ticket.frame.parent_work_version != first_work.version.opaque {
        return simple_refused("first work changed before followup");
    }
    match first_check {
        Some(value) => {
            if ticket.frame.parent_check_version != value.version.opaque {
                return simple_refused("first check changed before followup");
            }
        },
        None() => {
            if ticket.frame.parent_check_version != "" {
                return simple_refused("first check changed before followup");
            }
        },
    }
    match recoverable_followup_store_claim(ticket, policy, binding) {
        Ok(_) => (),
        Err(error) => {
            return simple_refused(error);
        }
    }
    if parsed.has_check {
        match recoverable_followup_check_store_plan(ticket, parsed.digest, policy, binding) {
            Ok(_) => (),
            Err(error) => {
                return simple_refused(error);
            }
        }
    }
    println("RESERVED event followup; interruption or uncertain effects cannot be retried automatically.");
    let prior_request = history.value.chat.last_request;
    let previous = history.value.chat.invocation.prior;
    let prior_work = PriorWork {
        request = first_work.value.work.request,
        summary = if first_work.value.work.phase == "abandoned" {
            "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit."
        } else {
            first_work.value.work.summary
        },
        summary_source = if first_work.value.work.phase == "abandoned" {
            "system"
        } else {
            origin
        },
        selection = chosen,
        check = checked,
        exit_code = exit,
        output = first_output,
        history = []
    };
    let wide = ticket.frame.work.format == 3 || ticket.frame.work.format == 4 || ticket.frame.work.format == 6
        || ticket.frame.work.format == 7 || ticket.frame.work.format == 8;
    let high_input = ticket.frame.work.format == 9 || ticket.frame.work.format == 10;
    let stages = HistoryFollowupStages {
        prior_request,
        previous,
        conversation,
        prior_work,
        wide = wide || high_input,
        high_input,
        historical = false
    };
    let persistence = RecoverableFollowupPersistence {
        ticket,
        redaction = policy,
        binding
    };
    return work_controller_execute<
        HistoryFollowupStages,
        Ticket,
        bool,
        RecoverableFollowupPersistence,
        NativeWorkEditor,
        TerminalPreview,
        EventWorkTimeline,
        TerminalWorkOutput
    >(
        stages,
        persistence,
        NativeWorkEditor {},
        TerminalPreview {},
        EventWorkTimeline {
            chat = history
        },
        TerminalWorkOutput {},
        input,
        Run {
            redaction = policy,
            binding,
            wide = wide
                || high_input,
            high_input,
            saved = "SAVED event followup facts; no grant or root identity is persisted."
        }
    );
}

public flow abandon(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Fs.read<PolicyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    if args.len() != 2 {
        return simple_refused("recovery requires binding and operation ID");
    }
    let policy = match event_policy_load() {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    let extra = match continuous_work_load(args[0]) {
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    let result = match extra {
        Some(item) => if item.value.current.result.phase == "complete" {
            abandon_check(args[0], args[1])
        } else {
            continuous_work_abandon(args[0], args[1])
        },
        None() => {
            let work = match followup_load(policy, args[0]) {
                Ok(Some(value)) => value,
                _ => {
                    return simple_refused("interrupted followup missing");
                }
            };
            if work.value.work.phase == "complete" {
                followup_checks_abandon(args[1], policy, args[0])
            } else {
                followup_abandon(args[1], policy, args[0])
            }
        },
    };
    return match result {
        Ok(_) => {
            println("RECORDED user decision: abandoned; interrupted outcome remains unknown; saved budgets are retained.");
            0
        }
        Err(error) => simple_refused(error)
    };
}
