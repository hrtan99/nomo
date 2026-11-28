module nomo.adapters.storage.work_admission;

import nomo.domain.sessions.work.{WorkPhase};
import nomo.domain.sessions.work.{WorkProfile, SummaryState, SummaryProvenance, SummarySource};
import nomo.domain.sessions.work.{CheckState, CheckOutcome};
import nomo.adapters.storage.chat.{chat_history_load, matches_version};
import nomo.adapters.storage.edits.{FirstEditJournal, edit_operation_store_begin, edit_operation_store_complete};
import nomo.adapters.storage.session_records.{commit_native, submit_native};
import nomo.application.editing.ports.{Ticket as ports_Ticket, WorkPersistence};
import nomo.application.sessions.admission.{
    chat_available as admission_chat_available,
    history_work_admit,
    history_work_claim,
    history_work_finish,
    history_work_inspect
};
import nomo.application.sessions.ports.{CasRows, Entry, HistoricalWorkTicket, PriorChatReader, Submission, Target};
import nomo.domain.conversation.TraceEvent;
import nomo.domain.editing.Binding;
import nomo.domain.harness.work.{WorkLedger, ledger_error, native_budget};
import nomo.domain.limits.compatible_scan_i32;
import nomo.domain.sessions.chat.{ChatSessionSnapshot, empty, work_batch};
import nomo.domain.sessions.event_codec.{Policy, encode_prefix, redact_text};
import nomo.domain.sessions.work.{
    ContinuousWorkHistory,
    ContinuousCheckAttempt,
    ContinuousCore,
    ContinuousEditState,
    ContinuousWorkEntry,
    WorkSummary,
    WorkSessionFrame,
    Summary,
    WorkAttempt,
    abandoned_record,
    admission_chat_error,
    completed_record,
    running_record_mode,
    work_data_error
};
import std.memory.{MemoryEntry, MemoryVersion, Missing, WriteCondition};

public flow continuous_work_load(binding: string) -> Result<Option<Stored>, string> {
    let row = ContinuousBooks.Rows.get_entry("latest");
    match row {
        Some(item) => {
            if item.key != "latest" || item.value.binding != binding {
                return Err("continuous work policy binding mismatch");
            }
        },
        None() => (),
    }
    return match row {
        Some(item) => Ok(Some(Stored {
            key = item.key,
            value = item.value,
            version = item.version
        })),
        None() => Ok(None())
    };
}

flow continuous_work_write(book: ContinuousWorkHistory, previous: Option<Stored>) -> Result<Stored, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let condition: WriteCondition = match previous {
        Some(item) => WriteCondition.Match(item.version),
        None() => Missing
    };
    let target = Target {
        store = ["Rows"],
        region = "nomo-continuous-work-v1",
        key = "latest",
        label = "continuous work"
    };
    let version = match commit_native(ContinuousBooks.Rows, target, book, condition) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match previous {
        Some(item) => {
            if item.version.opaque == version.opaque {
                return Err("continuous work version did not change");
            }
        },
        None() => (),
    }
    return Ok(Stored {
        key = "latest",
        value = book,
        version
    });
}

flow put(previous: Stored, item: ContinuousWorkEntry) -> Result<Stored, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    return continuous_work_write(previous.value {
        current = item
    }, Some(previous));
}

public flow continuous_work_admit(
    binding: string,
    id: string,
    workspace: string,
    path: string,
    request: string,
    digest: string,
    policy: Policy,
    wide: bool,
    high_input: bool
) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let previous = match continuous_work_load(binding) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    var history: Array<ContinuousWorkEntry> = [];
    match previous {
        Some(item) => {
            let last = item.value.current;
            if last.result.phase.is_abandoned() {
                if last.check.phase != CheckState.NotRequested && last.check.phase != CheckState.Planned {
                    return Err("abandoned check unresolved");
                }
            }
            else if !last.result.phase.is_complete() || (
                last.check.phase != CheckState.NotRequested
                    && !last.check.phase.is_complete() && last.check.phase != CheckState.Abandoned
            ) {
                return Err("previous work or check is unfinished");
            }
            history = item.value.history.push(last);
        }
        None() => (),
    }
    if history.len() >= 48 {
        return Err("continuous session history limit reached");
    }
    @limits([Iterations(48)]) for item in history {
        if item.core.id == id {
            return Err("work ID already used");
        }
    }
    @limits([Iterations(3)]) for field in [id, workspace, path] {
        let value = match redact_text(field, policy) {
            Ok(item) => item,
            Err(error) => {
                return Err(error);
            }
        };
        if value.replacements != 0 {
            return Err("work identity contains a known sensitive literal");
        }
    }
    let clean = match redact_text(request, policy) {
        Ok(value) => value.value,
        Err(error) => {
            return Err(error);
        }
    };
    let item = ContinuousWorkEntry {
        core = ContinuousCore {
            id,
            request = clean
        },
        edit = ContinuousEditState.NotStarted,
        result = WorkSummary {
            phase = SummaryState.Running(if high_input {
                WorkProfile.HighInputV2
            } else {
                if wide {
                    WorkProfile.WideV5
                } else {
                    WorkProfile.V2
                }
            }),
            summary = "",
            calls = 0,
            generation = 0,
            events = []
        },
        check = ContinuousCheckAttempt {
            phase = if digest == "" {
                CheckState.NotRequested
            } else {
                CheckState.Planned
            },
            digest,
            stdout = "",
            stderr = "",
            stdout_truncated = false,
            stderr_truncated = false
        }
    };
    return continuous_work_write(ContinuousWorkHistory {
        binding,
        history,
        current = item
    }, previous);
}

public flow edit_intent(ticket: Stored, binding: Binding) -> Result<Stored, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let item = ticket.value.current;
    if !item.result.phase.is_running() || item.edit != ContinuousEditState.NotStarted
        || binding.id != item.core.id {
        return Err("work edit changed");
    }
    return put(ticket, item {
        edit = ContinuousEditState.Intent(binding)
    });
}

public flow edit_complete(ticket: Stored) -> Result<Stored, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let item = ticket.value.current;
    if !item.edit.is_intent() {
        return Err("work edit intent missing");
    }
    return put(
        ticket,
        item {
            edit = match item.edit {
                ContinuousEditState.Intent(binding) => ContinuousEditState.Completed(binding),
                _ => {
                    return Err("work edit intent missing");
                }
            }
        }
    );
}

public flow continuous_work_finish(
    ticket: Stored,
    summary: string,
    source: SummarySource,
    spent: WorkLedger,
    records: Array<TraceEvent>,
    policy: Policy
) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let item = ticket.value.current;
    if !item.edit.is_completed() || !item.result.phase.is_running() {
        return Err("completed work edit required");
    }
    if ledger_error(spent) != "" || spent.read.calls + spent.edit.calls != 7 || spent.read.tokens
        + spent.edit.tokens != (
        if item.result.phase.profile() == WorkProfile.WideV5
            || item.result.phase.profile() == WorkProfile.WideV4 {
            286720
        } else {
            if item.result.phase.profile() == WorkProfile.HighInputV2 {
                917504
            } else {
                if item.result.phase.profile() == WorkProfile.WideV3
                    || item.result.phase.profile() == WorkProfile.HighInputV1 {
                    188416
                } else {
                    if item.result.phase.profile() == WorkProfile.Wide
                        || item.result.phase.profile() == WorkProfile.WideV2 {
                        61440
                    } else {
                        51200
                    }
                }
            }
        }
    ) {
        return Err("additional work ledger differs from reservation");
    }
    // High-input sources store their 6M configured run ceiling durably;
    // native_budget remains the compatible stage-shape counter, not usage.
    if (
        item.result.phase.profile() == WorkProfile.WideV5 || item.result.phase.profile() == WorkProfile.WideV4
            || item.result.phase.profile() == WorkProfile.WideV3
            || item.result.phase.profile() == WorkProfile.WideV2
            || item.result.phase.profile() == WorkProfile.V2
            || item.result.phase.profile() == WorkProfile.HighInputV1
            || item.result.phase.profile() == WorkProfile.HighInputV2
    )
        && (native_budget(spent) != (if item.result.phase.profile() == WorkProfile.HighInputV2 {
        7340032
    } else {
        if item.result.phase.profile() == WorkProfile.WideV5
            || item.result.phase.profile() == WorkProfile.WideV4 {
            2811008
        } else {
            if item.result.phase.profile() == WorkProfile.WideV3
                || item.result.phase.profile() == WorkProfile.HighInputV1 {
                2073152
            } else {
                1335296
            }
        }
    }) || !(
        if item.result.phase.profile() == WorkProfile.WideV5
            || item.result.phase.profile() == WorkProfile.HighInputV1
            || item.result.phase.profile() == WorkProfile.HighInputV2 {
            compatible_scan_i32(spent.read.scan)
        } else {
            spent.read.scan == 65540
        }
    )) {
        return Err("additional work native reservation differs");
    }
    let cleaned = match redact_text(summary, policy) {
        Ok(value) => value.value,
        Err(error) => {
            return Err(error);
        }
    };
    let saved = match work_batch(records, policy) {
        Ok(value) => value.events,
        Err(error) => {
            return Err(error);
        }
    };
    let result = WorkSummary {
        phase = SummaryState.Complete(SummaryProvenance.generated(item.result.phase.profile(), source)),
        summary = cleaned,
        calls = spent.read.calls + spent.edit.calls,
        generation = spent.read.tokens + spent.edit.tokens,
        events = saved
    };
    return put(ticket, item {
        result
    });
}

public flow start_check(binding: string, id: string, digest: string) -> Result<Stored, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let row = match continuous_work_load(binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("work missing");
        }
    };
    let item = row.value.current;
    if item.core.id != id || !item.result.phase.is_complete() || item.check.phase != CheckState.Planned
        || item.check.digest != digest {
        return Err("planned check missing");
    }
    let check = ContinuousCheckAttempt {
        phase = CheckState.Running,
        digest,
        stdout = "",
        stderr = "",
        stdout_truncated = false,
        stderr_truncated = false
    };
    return put(row, item {
        check
    });
}

public flow finish_check(
    binding: string,
    id: string,
    digest: string,
    outcome: CheckOutcome,
    stdout: string,
    stderr: string,
    out_truncated: bool,
    err_truncated: bool,
    policy: Policy
) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let row = match continuous_work_load(binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("work missing");
        }
    };
    let item = row.value.current;
    if item.core.id != id || item.check.phase != CheckState.Running || item.check.digest != digest {
        return Err("running check missing");
    }
    let out = match encode_prefix(stdout, out_truncated, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let err = match encode_prefix(stderr, err_truncated, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let check = ContinuousCheckAttempt {
        phase = CheckState.Complete(outcome),
        digest,
        stdout = out.value,
        stderr = err.value,
        stdout_truncated = out.truncated,
        stderr_truncated = err.truncated
    };
    return put(row, item {
        check
    });
}

public flow continuous_work_abandon(binding: string, id: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let row = match continuous_work_load(binding) {
        Ok(Some(value)) => value,
        _ => {
            return Err("interrupted work missing");
        }
    };
    let item = row.value.current;
    if item.core.id != id || !item.result.phase.is_running() || (
        item.check.phase != CheckState.NotRequested
            && item.check.phase != CheckState.Planned
    ) {
        return Err("interrupted work identity or phase differs");
    }
    let result = item.result {
        phase = SummaryState.Abandoned(item.result.phase.profile())
    };
    return match put(row, item {
        result
    }) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow abandon_check(binding: string, id: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let row = match continuous_work_load(binding) {
        Ok(Some(value)) => value,
        _ => {
            return Err("interrupted check missing");
        }
    };
    let item = row.value.current;
    if item.core.id != id || !item.result.phase.is_complete() || item.check.phase != CheckState.Running {
        return Err("interrupted check identity or phase differs");
    }
    let check = item.check {
        phase = CheckState.Abandoned
    };
    return match put(row, item {
        check
    }) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public type NativeHistoryWork = {};

impl NativeHistoryWork ~ CasRows<WorkAttempt> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-history-work-v1",
            key = "work",
            label = "history-work"
        };
    }

    flow submit(self, value: WorkAttempt, condition: WriteCondition) -> Submission ![
        Memory,
        Error<StorageError>
    ] {
        return submit_native(HistoryWorkRuns.Rows, "work", value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, WorkAttempt>>, string> {
        return Ok(HistoryWorkRuns.Rows.get_entry("work"));
    }

    flow same(self, left: WorkAttempt, right: WorkAttempt) -> bool ![] {
        return left == right;
    }
}

impl NativeHistoryWork ~ PriorChatReader {
    flow load(self) -> Result<Option<Entry>, string> {
        return chat_history_load();
    }
}

public flow historical_work_admit(
    id: string,
    workspace: string,
    path: string,
    request: string,
    history: Entry
) -> Result<HistoricalWorkTicket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return history_work_admit(NativeHistoryWork {}, id, workspace, path, request, history);
}

public flow historical_work_claim(ticket: HistoricalWorkTicket) -> Result<bool, string> {
    return history_work_claim(NativeHistoryWork {}, ticket);
}

public flow historical_work_finish(ticket: HistoricalWorkTicket, summary: string, spent: WorkLedger) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_work_finish(NativeHistoryWork {}, ticket, summary, spent);
}

public flow chat_available() -> Result<bool, string> {
    return admission_chat_available(NativeHistoryWork {});
}

public flow inspect() -> Result<Option<WorkAttempt>, string> {
    return history_work_inspect(NativeHistoryWork {});
}

flow frame_error(value: WorkSessionFrame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding {
        return "invalid recoverable work format or policy binding";
    }
    return work_data_error(value.work, value.events, policy);
}

public flow recoverable_work_store_load(policy: Policy, binding: string) -> Result<
    Option<MemoryEntry<string, WorkSessionFrame>>,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let row = RecoverableWorks.Rows.get_entry("work");
    return match row {
        Some(item) => {
            if item.key != "work" {
                return Err("recoverable work key mismatch");
            }
            let error = frame_error(item.value, policy, binding);
            if error != "" {
                return Err(error);
            }
            Ok(Some(item))
        }
        None() => Ok(None())
    };
}

flow recoverable_work_store_write(
    value: WorkSessionFrame,
    expected: Option<MemoryEntry<string, WorkSessionFrame>>,
    policy: Policy,
    binding: string
) -> Result<MemoryEntry<string, WorkSessionFrame>, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let desired = value {
        format = 1
    };
    let error = frame_error(desired, policy, binding);
    if error != "" {
        return Err(error);
    }
    let condition: WriteCondition = match expected {
        Some(item) => WriteCondition.Match(item.version),
        None() => Missing
    };
    let target = Target {
        store = ["Rows"],
        region = "nomo-recoverable-work-v1",
        key = "work",
        label = "recoverable work"
    };
    let version = match commit_native(RecoverableWorks.Rows, target, desired, condition) {
        Ok(item) => item,
        Err(problem) => {
            return Err(problem);
        }
    };
    // commit_native already verifies the exact stored value and version. Keep
    // the value already owned by this process instead of loading it again.
    match expected {
        Some(item) => {
            if item.version.opaque == version.opaque {
                return Err("recoverable work version did not change");
            }
        },
        None() => (),
    }
    return Ok(MemoryEntry {
        key = "work",
        value = desired,
        version
    });
}

public flow recoverable_work_store_admit(
    id: string,
    workspace: string,
    path: string,
    request: string,
    chat: MemoryEntry<string, ChatSessionSnapshot>,
    policy: Policy,
    binding: string
) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let chat_error = admission_chat_error(chat, chat);
    if chat_error != "" {
        return Err(chat_error);
    }
    let current = match matches_version(chat.version) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    if !current {
        return Err("completed recoverable chat changed; no retry");
    }
    match recoverable_work_store_load(policy, binding) {
        Ok(None()) => (),
        Ok(Some(_)) => {
            return Err("recoverable work already admitted; no retry");
        }
        Err(error) => {
            return Err(error);
        }
    }
    let wide = chat.value.chat.format >= 13;
    let row = running_record_mode(
        id,
        workspace,
        path,
        request,
        chat.version.opaque,
        wide,
        chat.value.chat.format == 18 || chat.value.chat.format == 19
    );
    let frame = WorkSessionFrame {
        format = 1,
        policy_binding = binding,
        work = row,
        events = empty()
    };
    let saved = match recoverable_work_store_write(frame, None(), policy, binding) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Ticket {
        frame,
        version = saved.version,
        chat
    });
}

flow claimed(ticket: Ticket, policy: Policy, binding: string) -> Result<
    MemoryEntry<string, WorkSessionFrame>,
    string
> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if ticket.frame.work.history_version != ticket.chat.version.opaque
        || ticket.frame.work.phase != WorkPhase.Running {
        return Err("recoverable work chat binding changed; no retry");
    }
    let current_chat = match matches_version(ticket.chat.version) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    if !current_chat {
        return Err("recoverable work chat binding changed; no retry");
    }
    let current = match recoverable_work_store_load(policy, binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("recoverable work missing or invalid");
        }
    };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque {
        return Err("recoverable work reservation changed; no retry");
    }
    return Ok(current);
}

public flow recoverable_work_store_claim(ticket: Ticket, policy: Policy, binding: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return match claimed(ticket, policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow recoverable_work_store_finish(
    ticket: Ticket,
    summary: string,
    spent: WorkLedger,
    records: Array<TraceEvent>,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let current = match claimed(ticket, policy, binding) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let events = match work_batch(records, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let row = completed_record(ticket.frame.work, summary, spent);
    let frame = WorkSessionFrame {
        format = 1,
        policy_binding = binding,
        work = row,
        events
    };
    match recoverable_work_store_write(frame, Some(current), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    }
}

// Only the owner which observed successful cleanup may call this decision flow.
public flow recoverable_work_store_abandon(id: string, policy: Policy, binding: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let current = match recoverable_work_store_load(policy, binding) {
        Ok(Some(value)) => value,
        _ => {
            return Err("interrupted work missing");
        }
    };
    let row = match abandoned_record(current.value.work, id, "work") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let frame = current.value {
        policy_binding = binding,
        work = row
    };
    return match recoverable_work_store_write(frame, Some(current), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public type FirstPersistence = {
    ticket: HistoricalWorkTicket,
    journal: FirstEditJournal
};

impl FirstPersistence ~ WorkPersistence<ports_Ticket, bool> {
    flow begin(self, selected: Binding) -> Result<ports_Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        match historical_work_claim(self.ticket) {
            Ok(_) => (),
            Err(error) => {
                return Err(error);
            }
        }
        return self.journal.begin(selected);
    }

    flow complete(self, ticket: ports_Ticket) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return self.journal.complete(ticket);
    }

    flow finish(self, edited: bool, summary: Summary, records: Array<TraceEvent>) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return historical_work_finish(self.ticket, summary.answer, summary.state);
    }
}

public type RecoverableFirstPersistence = {
    ticket: Ticket,
    redaction: Policy,
    binding: string
};

impl RecoverableFirstPersistence ~ WorkPersistence<ports_Ticket, bool> {
    flow begin(self, selected: Binding) -> Result<ports_Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        match recoverable_work_store_claim(self.ticket, self.redaction, self.binding) {
            Ok(_) => (),
            Err(error) => {
                return Err(error);
            }
        }
        return edit_operation_store_begin(selected);
    }

    flow complete(self, ticket: ports_Ticket) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return edit_operation_store_complete(ticket);
    }

    flow finish(self, edited: bool, summary: Summary, records: Array<TraceEvent>) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return recoverable_work_store_finish(
            self.ticket,
            summary.answer,
            summary.state,
            records,
            self.redaction,
            self.binding
        );
    }
}

public type ContinuousPersistence = {
    ticket: Stored,
    redaction: Policy
};

impl ContinuousPersistence ~ WorkPersistence<Stored, Stored> {
    flow begin(self, selected: Binding) -> Result<Stored, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>
    ] {
        return edit_intent(self.ticket, selected);
    }

    flow complete(self, ticket: Stored) -> Result<Stored, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>
    ] {
        return edit_complete(ticket);
    }

    flow finish(self, edited: Stored, summary: Summary, records: Array<TraceEvent>) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return match continuous_work_finish(
            edited,
            summary.answer,
            if summary.model_generated {
                SummarySource.Model
            } else {
                SummarySource.System
            },
            summary.state,
            records,
            self.redaction
        ) {
            Ok(_) => Ok(true),
            Err(error) => Err(error)
        };
    }
}

public type Stored = {
    key: string,
    value: ContinuousWorkHistory,
    version: MemoryVersion
};

public type Ticket = {
    frame: WorkSessionFrame,
    version: MemoryVersion,
    chat: MemoryEntry<string, ChatSessionSnapshot>
};

alias ContinuousBooksSchema = MemoryRegion<{
    Rows: Store<string, ContinuousWorkHistory>
}>;

public let ContinuousBooks = std.memory.region<ContinuousBooksSchema>(
    stable_id = "nomo-continuous-work-v1",
    store = "continuous-work"
);

alias HistoryWorkRunsSchema = MemoryRegion<{
    Rows: Store<string, WorkAttempt>
}>;

public let HistoryWorkRuns = std.memory.region<HistoryWorkRunsSchema>(
    stable_id = "nomo-history-work-v1",
    store = "history-work"
);

alias RecoverableWorksSchema = MemoryRegion<{
    Rows: Store<string, WorkSessionFrame>
}>;

public let RecoverableWorks = std.memory.region<RecoverableWorksSchema>(
    stable_id = "nomo-recoverable-work-v1",
    store = "recoverable-work"
);
