module nomo.application.sessions.admission;

import nomo.application.editing.ports.Ticket;
import nomo.application.sessions.persistence.commit_once;
import nomo.application.sessions.ports.{
    CasRows,
    Entry,
    FollowupPredecessors,
    HistoricalFollowupTicket,
    HistoricalWorkTicket,
    HistoryCheckRows,
    PriorChatReader
};
import nomo.domain.editing.{Selector, binding_error, record_error, same_record, selector_error};
import nomo.domain.sessions.work.{
    historical_followup_full,
    historical_followup_invalid,
    historical_followup_zero,
    historical_work_full,
    historical_work_invalid,
    historical_work_zero,
    invalid_values
};
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.edit_operation.{Binding, Record as edit_operation_Record};
import nomo.session.history_check_store.Record;
import nomo.session.history_followup_guard.{Parent, Record as history_followup_guard_Record};
import nomo.session.history_work_guard.Record as history_work_guard_Record;
import std.memory.{MemoryVersion, Missing, WriteCondition};

flow invalid<R ~ HistoryCheckRows>(rows: R, value: Record) -> string {
    return invalid_values(
        value.format,
        value.phase,
        value.id,
        value.digest,
        value.outcome,
        value.exit_code,
        rows.allow_abandoned()
    );
}

flow save<R ~ HistoryCheckRows>(rows: R, value: Record, condition: WriteCondition) -> Result<
    MemoryVersion,
    string
> {
    let error = invalid(rows, value);
    if error != "" {
        return Err(error);
    }
    return rows.write(value, condition);
}

public flow plan<R ~ HistoryCheckRows>(rows: R, id: string, digest: string) -> Result<bool, string> {
    if rows.read() != None() {
        return Err("history-check already planned; no retry");
    }
    let value = Record {
        format = 1,
        phase = "planned",
        id,
        digest,
        outcome = "",
        exit_code = ""
    };
    match save(rows, value, Missing) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    }
}

flow transition<R ~ HistoryCheckRows>(
    rows: R,
    id: string,
    digest: string,
    outcome: string,
    exit_code: string,
    finishing: bool
) -> Result<bool, string> {
    let proof = rows.confirmed_work(id);
    if proof != "" {
        return Err(proof);
    }
    let before = match rows.read() {
        Some(value) => value,
        None() => {
            return Err(if finishing {
                "running check missing"
            } else {
                "planned check missing"
            });
        }
    };
    let error = invalid(rows, before.value);
    if error != "" {
        return Err(error);
    }
    if before.key != "check" || before.value.id != id || before.value.digest != digest
        || before.value.phase != (if finishing {
        "running"
    } else {
        "planned"
    }) {
        return Err(if finishing {
            "running check differs; no retry"
        } else {
            "planned check differs; no retry"
        });
    }
    let value = Record {
        format = 1,
        phase = if finishing {
            "complete"
        } else {
            "running"
        },
        id,
        digest,
        outcome,
        exit_code
    };
    let version = match save(rows, value, WriteCondition.Match(before.version)) {
        Ok(item) => item,
        Err(problem) => {
            return Err(problem);
        }
    };
    if version.opaque == before.version.opaque {
        return Err("check version did not change");
    }
    return Ok(true);
}

public flow start<R ~ HistoryCheckRows>(rows: R, id: string, digest: string) -> Result<bool, string> {
    return transition(rows, id, digest, "", "", false);
}

public flow history_check_store_finish<R ~ HistoryCheckRows>(
    rows: R,
    id: string,
    digest: string,
    outcome: string,
    exit_code: string
) -> Result<bool, string> {
    return transition(rows, id, digest, outcome, exit_code, true);
}

public flow history_check_store_inspect<R ~ HistoryCheckRows>(rows: R) -> Result<Option<Record>, string> {
    let before = rows.read();
    match before {
        None() => Ok(None()),
        Some(value) => {
            let error = invalid(rows, value.value);
            if error != "" {
                return Err(error);
            }
            let work_id = match rows.recorded_work_id() {
                Ok(item) => item,
                Err(problem) => {
                    return Err(problem);
                }
            };
            if work_id != value.value.id {
                return Err("history-check work identity differs");
            }
            if value.value.phase != "planned" {
                let proof = rows.confirmed_work(value.value.id);
                if proof != "" {
                    return Err(proof);
                }
            }
            if value.key != "check" || rows.read() != before {
                return Err("history-check changed during status");
            }
            Ok(Some(value.value))
        }
    }
}

// Both namespaces share transitions, but each adapter has one fixed native store.
public flow available<S ~ CasRows<edit_operation_Record>>(rows: S) -> Result<bool, string> {
    return match rows.read() {
        Ok(None()) => Ok(true),
        Ok(Some(_)) => Err("edit operation slot already consumed; no retry"),
        Err(error) => Err(error)
    };
}

public flow begin<S ~ CasRows<edit_operation_Record>>(rows: S, binding: Binding) -> Result<Ticket, string> {
    let invalid = binding_error(binding);
    if invalid != "" {
        return Err(invalid);
    }
    match available(rows) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let row = edit_operation_Record {
        format = 1,
        phase = "intent",
        binding
    };
    let version = match commit_once<edit_operation_Record, S>(rows, row, Missing, None()) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Ticket {
        binding,
        version
    });
}

public flow complete<S ~ CasRows<edit_operation_Record>>(rows: S, ticket: Ticket) -> Result<bool, string> {
    let invalid = binding_error(ticket.binding);
    if invalid != "" {
        return Err(invalid);
    }
    let before = match rows.read() {
        Ok(Some(value)) => value,
        _ => {
            return Err("edit intent missing; no retry");
        }
    };
    let expected = edit_operation_Record {
        format = 1,
        phase = "intent",
        binding = ticket.binding
    };
    if before.key != "operation" || !same_record(before.value, expected)
        || before.version.opaque != ticket.version.opaque {
        return Err("edit intent binding or version changed; no retry");
    }
    let row = edit_operation_Record {
        format = 1,
        phase = "completed",
        binding = ticket.binding
    };
    return match commit_once<edit_operation_Record, S>(
        rows,
        row,
        WriteCondition.Match(before.version),
        Some(before.version)
    ) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

// Status reads never mutate or authorize an edit; completion is historical fact.
public flow edit_operations_inspect<S ~ CasRows<edit_operation_Record>>(rows: S, selector: Selector) -> Result<
    Option<edit_operation_Record>,
    string
> {
    let invalid = selector_error(selector.id, selector.workspace, selector.path);
    if invalid != "" {
        return Err(invalid);
    }
    let before = match rows.read() {
        Ok(Some(value)) => value,
        Ok(None()) => {
            return Ok(None());
        }
        Err(error) => {
            return Err(error);
        }
    };
    if before.key != "operation" {
        return Err("edit operation key mismatch");
    }
    let invalid_record = record_error(before.value);
    if invalid_record != "" {
        return Err(invalid_record);
    }
    let binding = before.value.binding;
    if binding.id != selector.id || binding.workspace != selector.workspace || binding.path != selector.path {
        return Err("edit operation identity or workspace binding mismatch");
    }
    let after = match rows.read() {
        Ok(Some(value)) => value,
        _ => {
            return Err("edit operation disappeared during status");
        }
    };
    if after.key != "operation" || after.version.opaque != before.version.opaque
        || !same_record(after.value, before.value) {
        return Err("edit operation changed during status");
    }
    return Ok(Some(before.value));
}

public flow parent<S ~ FollowupPredecessors>(source: S) -> Result<Parent, string> {
    let work = match source.work() {
        Ok(Some(value)) => value,
        _ => {
            return Err("completed first work required");
        }
    };
    if work.phase != "complete" {
        return Err("first work is unresolved; inspect without retry");
    }
    let edit = match source.edit(work.id, work.workspace, work.path) {
        Ok(Some(value)) => value,
        _ => {
            return Err("completed first edit required");
        }
    };
    if edit.phase != "completed" {
        return Err("first edit is unresolved");
    }
    let check = match source.check() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match check {
        Some(value) => {
            if value.phase != "complete" || value.id != work.id {
                return Err("first check is unresolved");
            }
        },
        None() => (),
    }
    return Ok(Parent {
        work,
        edit,
        check
    });
}

flow history_followup_history_error<S ~ PriorChatReader>(source: S, history: Entry) -> string {
    if history.key != "latest" || history.value.invocation.admitted < 1 || history.value.phase == "running"
        || history.value.pending != "" {
        return "completed chat history required";
    }
    let actual = match source.load() {
        Ok(Some(value)) => value,
        _ => {
            return "chat history missing or invalid";
        }
    };
    if actual != history {
        return "chat history changed; no retry";
    }
    return "";
}

flow history_followup_write<S ~ CasRows<history_followup_guard_Record>>(
    source: S,
    row: history_followup_guard_Record,
    condition: WriteCondition
) -> Result<MemoryVersion, string> {
    let error = historical_followup_invalid(row);
    if error != "" {
        return Err(error);
    }
    return commit_once<history_followup_guard_Record, S>(source, row, condition, None());
}

public flow history_followup_admit<
    S ~ CasRows<history_followup_guard_Record> + PriorChatReader
        + FollowupPredecessors
>(
    source: S,
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
    let before = match source.read() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if before != None() {
        return Err("followup slot already consumed; no retry");
    }
    let error = history_followup_history_error(source, history);
    if error != "" {
        return Err(error);
    }
    let prior = match parent(source) {
        Ok(value) => value,
        Err(problem) => {
            return Err(problem);
        }
    };
    let row = history_followup_guard_Record {
        format = 1,
        phase = "running",
        id,
        workspace,
        path,
        request,
        history_version = history.version.opaque,
        parent = prior,
        reserved = historical_followup_full(),
        settled = None(),
        summary = ""
    };
    let version = match history_followup_write(source, row, Missing) {
        Ok(value) => value,
        Err(problem) => {
            return Err(problem);
        }
    };
    return Ok(HistoricalFollowupTicket {
        record = row,
        version,
        history
    });
}

public flow history_followup_claim<
    S ~ CasRows<history_followup_guard_Record> + PriorChatReader
        + FollowupPredecessors
>(source: S, ticket: HistoricalFollowupTicket) -> Result<bool, string> {
    let error = historical_followup_invalid(ticket.record);
    if error != "" {
        return Err(error);
    }
    let h = history_followup_history_error(source, ticket.history);
    if h != "" {
        return Err(h);
    }
    let prior = match parent(source) {
        Ok(value) => value,
        Err(problem) => {
            return Err(problem);
        }
    };
    if prior != ticket.record.parent {
        return Err("first work changed; no retry");
    }
    if ticket.record.phase != "running" || ticket.record.history_version != ticket.history.version.opaque {
        return Err("followup ticket changed");
    }
    let actual = match source.read() {
        Ok(Some(value)) => value,
        Ok(None()) => {
            return Err("followup reservation missing");
        }
        Err(error) => {
            return Err(error);
        }
    };
    if actual.key != "followup" || actual.value != ticket.record
        || actual.version.opaque != ticket.version.opaque {
        return Err("followup reservation changed; no retry");
    }
    return Ok(true);
}

public flow history_followup_finish<
    S ~ CasRows<history_followup_guard_Record> + PriorChatReader
        + FollowupPredecessors
>(source: S, ticket: HistoricalFollowupTicket, summary: string, spent: Ledger) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match history_followup_claim(source, ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let old = ticket.record;
    let row = old {
        format = 1,
        phase = "complete",
        reserved = historical_followup_zero(),
        settled = Some(spent),
        summary
    };
    let version = match history_followup_write(source, row, WriteCondition.Match(ticket.version)) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if version.opaque == ticket.version.opaque {
        return Err("followup version did not change");
    }
    return Ok(true);
}

public flow history_followup_inspect<
    S ~ CasRows<history_followup_guard_Record>
        + FollowupPredecessors
>(source: S) -> Result<Option<history_followup_guard_Record>, string> {
    let before = match source.read() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match before {
        None() => {
            return Ok(None());
        }
        Some(value) => {
            let error = historical_followup_invalid(value.value);
            if error != "" {
                return Err(error);
            }
            let prior = match parent(source) {
                Ok(item) => item,
                Err(problem) => {
                    return Err(problem);
                }
            };
            if value.key != "followup" || value.value.parent != prior || (
                match source.read() {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(error);
                    }
                }
            ) != before {
                return Err("followup status changed or predecessor differs");
            }
            return Ok(Some(value.value));
        }
    }
}

flow history_work_history_error<S ~ PriorChatReader>(source: S, history: Entry) -> string {
    if history.key != "latest" || history.value.invocation.admitted < 1 || history.value.phase == "running"
        || history.value.pending != "" {
        return "a completed prior chat turn is required";
    }
    let actual = match source.load() {
        Ok(Some(value)) => value,
        _ => {
            return "chat history missing or invalid";
        }
    };
    if actual != history {
        return "chat history changed; no retry";
    }
    return "";
}

flow history_work_write<S ~ CasRows<history_work_guard_Record>>(
    rows: S,
    row: history_work_guard_Record,
    condition: WriteCondition
) -> Result<MemoryVersion, string> {
    let error = historical_work_invalid(row);
    if error != "" {
        return Err(error);
    }
    return commit_once<history_work_guard_Record, S>(rows, row, condition, None());
}

public flow history_work_admit<
    S ~ CasRows<history_work_guard_Record>
        + PriorChatReader
>(
    source: S,
    id: string,
    workspace: string,
    path: string,
    request: string,
    history: Entry
) -> Result<HistoricalWorkTicket, string> {
    let before = match source.read() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if before != None() {
        return Err("history-work already admitted; no retry");
    }
    let error = history_work_history_error(source, history);
    if error != "" {
        return Err(error);
    }
    let row = history_work_guard_Record {
        format = 1,
        phase = "running",
        id,
        workspace,
        path,
        request,
        history_version = history.version.opaque,
        reserved = historical_work_full(),
        settled = None(),
        summary = ""
    };
    let version = match history_work_write(source, row, Missing) {
        Ok(value) => value,
        Err(problem) => {
            return Err(problem);
        }
    };
    return Ok(HistoricalWorkTicket {
        record = row,
        version,
        history
    });
}

public flow history_work_claim<
    S ~ CasRows<history_work_guard_Record>
        + PriorChatReader
>(source: S, ticket: HistoricalWorkTicket) -> Result<bool, string> {
    let error = historical_work_invalid(ticket.record);
    if error != "" {
        return Err(error);
    }
    let history = history_work_history_error(source, ticket.history);
    if history != "" {
        return Err(history);
    }
    if ticket.record.phase != "running" || ticket.record.history_version != ticket.history.version.opaque {
        return Err("history-work ticket changed");
    }
    let actual = match source.read() {
        Ok(Some(value)) => value,
        Ok(None()) => {
            return Err("history-work reservation missing");
        }
        Err(error) => {
            return Err(error);
        }
    };
    if actual.key != "work" || actual.value != ticket.record || actual.version.opaque != ticket.version.opaque {
        return Err("history-work reservation changed; no retry");
    }
    return Ok(true);
}

public flow history_work_finish<
    S ~ CasRows<history_work_guard_Record>
        + PriorChatReader
>(source: S, ticket: HistoricalWorkTicket, summary: string, spent: Ledger) -> Result<
    bool,
    string
> {
    match history_work_claim(source, ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let old = ticket.record;
    let row = old {
        format = 1,
        phase = "complete",
        reserved = historical_work_zero(),
        settled = Some(spent),
        summary
    };
    let version = match history_work_write(source, row, WriteCondition.Match(ticket.version)) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if version.opaque == ticket.version.opaque {
        return Err("history-work version did not change");
    }
    return Ok(true);
}

public flow chat_available<S ~ CasRows<history_work_guard_Record>>(rows: S) -> Result<bool, string> {
    return match rows.read() {
        Ok(None()) => Ok(true),
        Ok(Some(_)) => Err("history-work consumes this session; no chat continuation"),
        Err(error) => Err(error)
    };
}

// Status is data only; it is never a current root observation or a grant.
public flow history_work_inspect<S ~ CasRows<history_work_guard_Record>>(rows: S) -> Result<
    Option<history_work_guard_Record>,
    string
> {
    let before = match rows.read() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match before {
        None() => {
            return Ok(None());
        }
        Some(value) => {
            let error = historical_work_invalid(value.value);
            if error != "" {
                return Err(error);
            }
            if value.key != "work" {
                return Err("history-work status key mismatch");
            }
            let after = match rows.read() {
                Ok(value) => value,
                Err(error) => {
                    return Err(error);
                }
            };
            if after != before {
                return Err("history-work changed during status");
            }
            return Ok(Some(value.value));
        }
    }
}
