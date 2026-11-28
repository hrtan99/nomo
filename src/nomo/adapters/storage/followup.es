module nomo.adapters.storage.followup;

import nomo.adapters.storage.chat.{chat_history_load, recoverable_chat_store_load};
import nomo.adapters.storage.checks.{inspect as checks_inspect, load as checks_load};
import nomo.adapters.storage.edits.{
    FollowupEditJournal,
    edit_operation_store_inspect,
    history_followup_edit_store_begin,
    history_followup_edit_store_complete
};
import nomo.adapters.storage.session_records.{commit_native, submit_native};
import nomo.adapters.storage.work_admission.{inspect as work_admission_inspect, recoverable_work_store_load};
import nomo.application.editing.ports.{Ticket as ports_Ticket, WorkPersistence};
import nomo.application.sessions.admission.{
    history_followup_admit,
    history_followup_claim,
    history_followup_finish,
    history_followup_inspect,
    parent as admission_parent
};
import nomo.application.sessions.ports.{
    CasRows,
    Entry,
    FollowupPredecessors,
    HistoricalFollowupTicket,
    PriorChatReader,
    Submission,
    Target
};
import nomo.core.conversation.Event;
import nomo.domain.sessions.chat.{empty, work_batch};
import nomo.domain.sessions.event_codec.Policy;
import nomo.domain.sessions.work.{
    Summary,
    abandoned_record,
    admission_chat_error,
    claim_chat_error,
    completed_record,
    running_record_mode,
    work_data_error
};
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.edit_operation.{Binding, Record as edit_operation_Record};
import nomo.session.history_check_store.Record as history_check_store_Record;
import nomo.session.history_followup_guard.{Parent, Record, Runs};
import nomo.session.history_work_guard.Record as history_work_guard_Record;
import nomo.session.recoverable_chat_store.Frame as recoverable_chat_store_Frame;
import nomo.session.recoverable_followup_store.{Frame, Runs as recoverable_followup_store_Runs};
import std.memory.{MemoryEntry, MemoryVersion, Missing, WriteCondition};

public type NativeHistoryFollowup = {};

impl NativeHistoryFollowup ~ CasRows<Record> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-history-followup-v1",
            key = "followup",
            label = "followup"
        };
    }

    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] {
        return submit_native(Runs.Rows, "followup", value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> {
        return Ok(Runs.Rows.get_entry("followup"));
    }

    flow same(self, left: Record, right: Record) -> bool ![] {
        return left == right;
    }
}

impl NativeHistoryFollowup ~ PriorChatReader {
    flow load(self) -> Result<Option<Entry>, string> {
        return chat_history_load();
    }
}

impl NativeHistoryFollowup ~ FollowupPredecessors {
    flow work(self) -> Result<Option<history_work_guard_Record>, string> {
        return work_admission_inspect();
    }

    flow edit(self, id: string, workspace: string, path: string) -> Result<
        Option<edit_operation_Record>,
        string
    > {
        return edit_operation_store_inspect(id, workspace, path);
    }

    flow check(self) -> Result<Option<history_check_store_Record>, string> {
        return checks_inspect();
    }
}

public flow parent() -> Result<Parent, string> {
    return admission_parent(NativeHistoryFollowup {});
}

public flow historical_followup_admit(
    id: string,
    workspace: string,
    path: string,
    request: string,
    history: Entry
) -> Result<HistoricalFollowupTicket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return history_followup_admit(NativeHistoryFollowup {}, id, workspace, path, request, history);
}

public flow historical_followup_claim(ticket: HistoricalFollowupTicket) -> Result<bool, string> {
    return history_followup_claim(NativeHistoryFollowup {}, ticket);
}

public flow historical_followup_finish(ticket: HistoricalFollowupTicket, summary: string, spent: Ledger) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_followup_finish(NativeHistoryFollowup {}, ticket, summary, spent);
}

public flow inspect() -> Result<Option<Record>, string> {
    return history_followup_inspect(NativeHistoryFollowup {});
}

flow frame_error(value: Frame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding || value.parent_work_version == "" {
        return "invalid recoverable followup format or policy binding";
    }
    return work_data_error(value.work, value.events, policy);
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    // Validate the policy/binding against the actual chat frame first; a stale
    // or mismatched policy cannot make an existing work slot look absent.
    match recoverable_chat_store_load(policy, binding) {
        Ok(Some(_)) => (),
        Ok(None()) => {
            return Err("recoverable chat missing");
        }
        Err(error) => {
            return Err(error);
        }
    }
    let row = recoverable_followup_store_Runs.Rows.get_entry("followup");
    return match row {
        Some(item) => {
            if item.key != "followup" {
                return Err("recoverable followup key mismatch");
            }
            let value = item.value;
            let error = frame_error(value, policy, binding);
            if error != "" {
                return Err(error);
            }
            let parent_work = match recoverable_work_store_load(policy, binding) {
                Ok(Some(value)) => value,
                _ => {
                    return Err("first work missing");
                }
            };
            if (parent_work.value.work.phase != "complete" && parent_work.value.work.phase != "abandoned")
                || parent_work.version.opaque != value.parent_work_version
                || parent_work.value.work.id == value.work.id {
                return Err("first work changed");
            }
            if parent_work.value.work.phase == "complete" {
                let parent_edit = match edit_operation_store_inspect(
                    parent_work.value.work.id,
                    parent_work.value.work.workspace,
                    parent_work.value.work.path
                ) {
                    Ok(Some(value)) => value,
                    _ => {
                        return Err("first edit missing");
                    }
                };
                if parent_edit.phase != "completed" {
                    return Err("first edit unresolved");
                }
            }
            let parent_check = match checks_load(policy, binding) {
                Ok(value) => value,
                Err(error) => {
                    return Err(error);
                }
            };
            let check_version = match parent_check {
                Some(value) => {
                    if value.value.check.phase != "complete" && value.value.check.phase != "abandoned"
                        && !(
                        parent_work.value.work.phase == "abandoned"
                            && value.value.check.phase == "planned"
                    ) {
                        return Err("first check unresolved");
                    }
                    value.version.opaque
                },
                None() => ""
            };
            if check_version != value.parent_check_version {
                return Err("first check changed");
            }
            Ok(Some(item))
        }
        None() => Ok(None())
    };
}

flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<
    MemoryVersion,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let desired = value {
        format = 1
    };
    let error = frame_error(desired, policy, binding);
    if error != "" {
        return Err(error);
    }
    let before = match load(policy, binding) {
        Ok(item) => item,
        Err(problem) => {
            return Err(problem);
        }
    };
    if before != expected {
        return Err("recoverable followup changed; no retry");
    }
    let condition: WriteCondition = match expected {
        Some(item) => WriteCondition.Match(item.version),
        None() => Missing
    };
    let target = Target {
        store = ["Rows"],
        region = "nomo-recoverable-followup-v1",
        key = "followup",
        label = "recoverable followup"
    };
    let version = match commit_native(recoverable_followup_store_Runs.Rows, target, desired, condition) {
        Ok(item) => item,
        Err(problem) => {
            return Err(problem);
        }
    };
    match expected {
        Some(item) => {
            if item.version.opaque == version.opaque {
                return Err("recoverable followup version did not change");
            }
        },
        None() => (),
    }
    return Ok(version);
}

public flow recoverable_followup_store_admit(
    id: string,
    workspace: string,
    path: string,
    request: string,
    chat: MemoryEntry<string, recoverable_chat_store_Frame>,
    policy: Policy,
    binding: string
) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let current = match recoverable_chat_store_load(policy, binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("recoverable chat missing or invalid");
        }
    };
    let chat_error = admission_chat_error(current, chat);
    if chat_error != "" {
        return Err(chat_error);
    }
    match load(policy, binding) {
        Ok(None()) => (),
        Ok(Some(_)) => {
            return Err("recoverable followup already admitted; no retry");
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
    let parent_work = match recoverable_work_store_load(policy, binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("completed first work required");
        }
    };
    if (parent_work.value.work.phase != "complete" && parent_work.value.work.phase != "abandoned")
        || parent_work.value.work.id == id {
        return Err("completed distinct first work required");
    }
    if parent_work.value.work.phase == "complete" {
        let first_edit = match edit_operation_store_inspect(
            parent_work.value.work.id,
            parent_work.value.work.workspace,
            parent_work.value.work.path
        ) {
            Ok(Some(item)) => item,
            _ => {
                return Err("completed first edit required");
            }
        };
        if first_edit.phase != "completed" {
            return Err("completed first edit required");
        }
    }
    let parent_check = match checks_load(policy, binding) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let check_version = match parent_check {
        Some(item) => {
            if item.value.check.phase != "complete" && item.value.check.phase != "abandoned"
                && !(parent_work.value.work.phase == "abandoned" && item.value.check.phase == "planned") {
                return Err("first check unresolved");
            }
            item.version.opaque
        },
        None() => ""
    };
    let frame = Frame {
        format = 1,
        policy_binding = binding,
        parent_work_version = parent_work.version.opaque,
        parent_check_version = check_version,
        work = row,
        events = empty()
    };
    let version = match write(frame, None(), policy, binding) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Ticket {
        frame,
        version,
        chat
    });
}

public flow recoverable_followup_store_claim(ticket: Ticket, policy: Policy, binding: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let current_chat = match recoverable_chat_store_load(policy, binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("recoverable chat missing or invalid");
        }
    };
    let chat_error = claim_chat_error(current_chat, ticket.chat, ticket.frame.work, "recoverable followup");
    if chat_error != "" {
        return Err(chat_error);
    }
    let current = match load(policy, binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("recoverable followup missing or invalid");
        }
    };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque {
        return Err("recoverable followup reservation changed; no retry");
    }
    return Ok(true);
}

public flow recoverable_followup_store_finish(
    ticket: Ticket,
    summary: string,
    spent: Ledger,
    records: Array<Event>,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match recoverable_followup_store_claim(ticket, policy, binding) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let events = match work_batch(records, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let row = completed_record(ticket.frame.work, summary, spent);
    let frame = ticket.frame {
        format = 1,
        policy_binding = binding,
        work = row,
        events
    };
    let current = match load(policy, binding) {
        Ok(Some(item)) => item,
        _ => {
            return Err("recoverable followup missing or invalid");
        }
    };
    if current.value != ticket.frame || current.version.opaque != ticket.version.opaque {
        return Err("recoverable followup reservation changed; no retry");
    }
    match write(frame, Some(current), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    }
}

public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let current = match load(policy, binding) {
        Ok(Some(value)) => value,
        _ => {
            return Err("interrupted followup missing");
        }
    };
    let old = current.value.work;
    let row = match abandoned_record(old, id, "followup") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let frame = current.value {
        policy_binding = binding,
        work = row
    };
    return match write(frame, Some(current), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public type FollowupPersistence = {
    ticket: HistoricalFollowupTicket,
    journal: FollowupEditJournal
};

impl FollowupPersistence ~ WorkPersistence<ports_Ticket, bool> {
    flow begin(self, selected: Binding) -> Result<ports_Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        match historical_followup_claim(self.ticket) {
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

    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return historical_followup_finish(self.ticket, summary.answer, summary.state);
    }
}

public type RecoverableFollowupPersistence = {
    ticket: Ticket,
    redaction: Policy,
    binding: string
};

impl RecoverableFollowupPersistence ~ WorkPersistence<ports_Ticket, bool> {
    flow begin(self, selected: Binding) -> Result<ports_Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        match recoverable_followup_store_claim(self.ticket, self.redaction, self.binding) {
            Ok(_) => (),
            Err(error) => {
                return Err(error);
            }
        }
        return history_followup_edit_store_begin(selected);
    }

    flow complete(self, ticket: ports_Ticket) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return history_followup_edit_store_complete(ticket);
    }

    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return recoverable_followup_store_finish(
            self.ticket,
            summary.answer,
            summary.state,
            records,
            self.redaction,
            self.binding
        );
    }
}

public type Ticket = {
    frame: Frame,
    version: MemoryVersion,
    chat: MemoryEntry<string, recoverable_chat_store_Frame>
};
