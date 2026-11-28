module nomo.adapters.cli.work;

import nomo.adapters.cli.console.{TerminalWorkOutput, display, ledger, simple_refused};
import nomo.adapters.cli.edit_input.{application, edit_args_parse, harness_work_args_parse, parse_recorded};
import nomo.adapters.cli.editing.{LegacyWorkOutput, TerminalPreview, execute, render};
import nomo.adapters.cli.harness.{finish_edit, harness_work_entry_refused, prepare_work, summarize};
import nomo.adapters.filesystem.editing.{LegacyWorkEditor, NativeWorkEditor};
import nomo.adapters.storage.chat.{chat_history_load, conversation as chat_conversation, recoverable_chat_store_load};
import nomo.adapters.storage.check_lifecycle.FirstCheck;
import nomo.adapters.storage.checks.{history_check_guard_plan, inspect as checks_inspect, load, recoverable_check_store_plan};
import nomo.adapters.storage.edits.{
    FirstEditJournal,
    edit_operation_store_available,
    history_followup_edit_store_available,
    publish,
    work_record_store_available,
    work_record_store_complete,
    work_record_store_inspect
};
import nomo.adapters.storage.followup.inspect as followup_inspect;
import nomo.adapters.storage.followup_checks.inspect as followup_checks_inspect;
import nomo.adapters.storage.session_records.event_policy_load;
import nomo.adapters.storage.work_admission.{
    FirstPersistence,
    RecoverableFirstPersistence,
    historical_work_admit,
    historical_work_claim,
    inspect,
    recoverable_work_store_abandon,
    recoverable_work_store_admit,
    recoverable_work_store_claim,
    recoverable_work_store_load
};
import nomo.adapters.storage.work_history.{EventWorkTimeline, LegacyWorkTimeline};
import nomo.application.editing.ports.{Approval as ports_Approval, Run, Ticket};
import nomo.application.editing.workflow.work_controller_execute;
import nomo.application.resources.{EditableRoot, PolicyRoot, ReadOnlyRoot};
import nomo.bootstrap.work.HistoryWorkStages;
import nomo.domain.editing.{bind, same_binding};
import nomo.domain.harness.work.fresh;
import nomo.domain.sessions.event_codec.Policy;
import nomo.domain.sessions.work.{admit, partial};
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println};

flow refused(error: string) -> i32 {
    println("REFUSED " + error);
    return 1;
}

// Current roots and current approval are supplied by this invocation. Saved
// history is only model input, never proof of a current root or consent.
public flow history_work_run(args: Array<string>) -> i32 ![
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
    let journal = FirstEditJournal {};
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
    let ticket = match historical_work_admit(
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
    match historical_work_claim(ticket) {
        Ok(_) => (),
        Err(error) => {
            return refused(error);
        }
    }
    if parsed.has_check {
        match history_check_guard_plan(ticket, parsed.digest) {
            Ok(_) => (),
            Err(error) => {
                return refused(error);
            }
        }
    }
    println("RESERVED history-work; failure or interruption cannot be retried automatically.");
    let stages = HistoryWorkStages {
        prior_request = history.value.last_request,
        previous = history.value.invocation.prior,
        conversation = [],
        wide = false,
        high_input = false,
        historical = true
    };
    let persistence = FirstPersistence {
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
        saved = "SAVED history-work; captured history is not a root identity or grant."
    };
    return work_controller_execute<
        HistoryWorkStages,
        Ticket,
        bool,
        FirstPersistence,
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

public flow recoverable_history_work_run(args: Array<string>) -> i32 ![
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
        return simple_refused("event work requires a policy binding");
    }
    let binding = args[args.len() - 1];
    let parsed = match parse_recorded(args, 2, false) {
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
        Ok(value) => value,
        Err(error) => {
            return simple_refused(error);
        }
    };
    match chat_history_load() {
        Ok(None()) => (),
        _ => {
            return simple_refused("legacy session cannot be migrated automatically");
        }
    }
    match inspect() {
        Ok(None()) => (),
        _ => {
            return simple_refused("legacy work exists or is invalid");
        }
    }
    match checks_inspect() {
        Ok(None()) => (),
        _ => {
            return simple_refused("legacy check exists or is invalid");
        }
    }
    match followup_inspect() {
        Ok(None()) => (),
        _ => {
            return simple_refused("legacy followup exists or is invalid");
        }
    }
    match followup_checks_inspect() {
        Ok(None()) => (),
        _ => {
            return simple_refused("legacy followup check exists or is invalid");
        }
    }
    match history_followup_edit_store_available() {
        Ok(_) => (),
        _ => {
            return simple_refused("legacy followup edit exists or is invalid");
        }
    }
    match edit_operation_store_available() {
        Ok(_) => (),
        Err(error) => {
            return simple_refused(error);
        }
    }
    let history = match recoverable_chat_store_load(policy, binding) {
        Ok(Some(value)) => value,
        _ => {
            return simple_refused("saved event chat missing or invalid");
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
    match load(policy, binding) {
        Ok(None()) => (),
        _ => {
            return simple_refused("check already exists or is invalid");
        }
    }
    let ticket = match recoverable_work_store_admit(
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
    match recoverable_work_store_claim(ticket, policy, binding) {
        Ok(_) => (),
        Err(error) => {
            return simple_refused(error);
        }
    }
    if parsed.has_check {
        match recoverable_check_store_plan(ticket, parsed.digest, policy, binding) {
            Ok(_) => (),
            Err(error) => {
                return simple_refused(error);
            }
        }
    }
    println("RESERVED event work; interruption or uncertain effects cannot be retried automatically.");
    let prior_request = history.value.chat.last_request;
    let previous = history.value.chat.invocation.prior;
    let wide = ticket.frame.work.format == 3 || ticket.frame.work.format == 4 || ticket.frame.work.format == 6
        || ticket.frame.work.format == 7 || ticket.frame.work.format == 8;
    let high_input = ticket.frame.work.format == 9 || ticket.frame.work.format == 10;
    let stages = HistoryWorkStages {
        prior_request,
        previous,
        conversation,
        wide = wide || high_input,
        high_input,
        historical = false
    };
    let persistence = RecoverableFirstPersistence {
        ticket,
        redaction = policy,
        binding
    };
    return work_controller_execute<
        HistoryWorkStages,
        Ticket,
        bool,
        RecoverableFirstPersistence,
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
            saved = "SAVED event work facts; no grant or root identity is persisted."
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
    let work = match recoverable_work_store_load(policy, args[0]) {
        Ok(Some(value)) => value,
        _ => {
            return simple_refused("interrupted work missing");
        }
    };
    let checks = FirstCheck {
        redaction = policy,
        binding = args[0]
    };
    let decision = if work.value.work.phase == "complete" {
        checks.abandon(args[1])
    } else {
        recoverable_work_store_abandon(args[1], policy, args[0])
    };
    match decision {
        Ok(_) => {
            println("RECORDED user decision: abandoned; interrupted outcome remains unknown; saved budgets are retained.");
            return 0;
        }
        Err(error) => {
            return simple_refused(error);
        }
    }
}

public flow run_save(args: Array<string>) -> i32 ![
    Console,
    Memory,
    ports_Approval,
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
    let input = match harness_work_args_parse(args) {
        Ok(value) => value,
        Err(error) => {
            return harness_work_entry_refused(fresh(), error);
        }
    };
    if input.edit.help {
        println("work_save: --id ID --workspace BIND --path FILE --once TASK --allow FILE[,FILE]; one confirmed edit, one durable work record, no executable resume.");
        return 0;
    }
    match edit_operation_store_available() {
        Ok(_) => (),
        Err(error) => {
            return harness_work_entry_refused(fresh(), error);
        }
    }
    match work_record_store_available(input.edit.id, input.edit.workspace, input.edit.path) {
        Ok(_) => (),
        Err(error) => {
            return harness_work_entry_refused(fresh(), error);
        }
    }
    let pending = match prepare_work(input) {
        Ok(value) => value,
        Err(failure) => {
            return harness_work_entry_refused(failure.state, failure.error);
        }
    };
    let selected = pending.selected;
    let predicted = match bind(selected.id, selected.workspace, selected.path, pending.prepared) {
        Ok(value) => value,
        Err(error) => {
            return harness_work_entry_refused(pending.state, error);
        }
    };
    let candidate = match partial(predicted, pending.evidence, pending.task, pending.prepared) {
        Ok(value) => value,
        Err(error) => {
            return harness_work_entry_refused(pending.state, error);
        }
    };
    match admit(candidate) {
        Ok(_) => (),
        Err(error) => {
            return harness_work_entry_refused(pending.state, error);
        }
    }
    let outcome = match execute(selected, pending.prepared) {
        Ok(value) => value,
        Err(error) => {
            return harness_work_entry_refused(pending.state, error);
        }
    };
    let completed = match finish_edit(pending, outcome) {
        Ok(value) => value,
        Err(failure) => {
            return harness_work_entry_refused(failure.state, failure.error);
        }
    };
    if !same_binding(outcome.binding, candidate.binding) || outcome.after != pending.prepared.proposal.after {
        return harness_work_entry_refused(
            completed.state,
            "edit completed; confirmed outcome differs from admitted work; work not saved"
        );
    }
    println("WORK pending; edit completed; work record is not yet confirmed saved; no edit retry or rollback.");
    let ticket = match publish(candidate) {
        Ok(value) => value,
        Err(error) => {
            return harness_work_entry_refused(
                completed.state,
                "edit completed; work not confirmed saved; " + error
            );
        }
    };
    println("WORK durable edit-completed / summary-unconfirmed; reservation1 step/1 call/2048 generation/65536 native may be attempted; no resume or replay.");
    let summary = match summarize(completed) {
        Ok(value) => value,
        Err(failure) => {
            return harness_work_entry_refused(failure.state, failure.error);
        }
    };
    match work_record_store_complete(ticket, summary.answer) {
        Ok(_) => (),
        Err(error) => {
            return harness_work_entry_refused(
                summary.state,
                "edit completed; summary update not confirmed saved; " + error
            );
        }
    }
    println("SAVED work record summary-confirmed; edit and work records are separate commits.");
    display("FINAL ", summary.answer);
    ledger(summary.state);
    return 0;
}

public flow run_show(args: Array<string>) -> i32 {
    let input = match edit_args_parse(args, false) {
        Ok(value) => value,
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    };
    if input.help {
        println("work_show: --id ID --workspace BIND --path FILE; captured application data only, no executable resume.");
        return 0;
    }
    let row = match work_record_store_inspect(input.id, input.workspace, input.path) {
        Ok(Some(value)) => value,
        Ok(None()) => {
            println("WORK missing; a missing work record does not establish that no edit occurred.");
            return 0;
        }
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    };
    let lines = match render(row) {
        Ok(value) => value,
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    };
    @limits([Iterations(7)]) for line in lines {
        println(line);
    }
    println("Captured edit facts; current file state is not checked. Reservations are configured allowances, may have been attempted, and never authorize resume or replay.");
    return 0;
}
