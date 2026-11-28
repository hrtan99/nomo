module nomo.adapters.storage.checks;

import nomo.adapters.storage.edits.edit_operation_store_inspect;
import nomo.adapters.storage.session_records.{commit_native, submit_native};
import nomo.adapters.storage.work_admission.{
    Ticket,
    historical_work_claim,
    inspect as work_admission_inspect,
    recoverable_work_store_claim,
    recoverable_work_store_load
};
import nomo.application.sessions.admission.{history_check_store_finish, history_check_store_inspect, plan, start};
import nomo.application.sessions.persistence.commit_once;
import nomo.application.sessions.ports.{
    CasRows,
    CheckAccess,
    HistoricalWorkTicket,
    HistoryCheckRows,
    Submission,
    Target
};
import nomo.domain.sessions.event_codec.{Policy, encode_prefix, event_text_codec_decode};
import nomo.domain.sessions.work.invalid_values;
import nomo.session.check_store.Frame;
import nomo.session.history_check_store.Record as history_check_store_Record;
import nomo.session.history_first_check_rows.Checks;
import nomo.session.history_work_guard.Record;
import nomo.session.recoverable_check_store.Checks as recoverable_check_store_Checks;
import std.memory.{MemoryEntry, MemoryVersion, Missing, WriteCondition};

public flow check_store_invalid(value: Frame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding || value.work_history == ""
        || value.workspace == "" || value.path == "" {
        return "invalid recoverable check binding";
    }
    let error = history_check_guard_invalid(value.check);
    if error != "" {
        return error;
    }
    if value.check.phase != "complete" {
        if value.stdout != "" || value.stderr != "" || value.stdout_truncated || value.stderr_truncated {
            return "unfinished check has output";
        }
    } else {
        match event_text_codec_decode(value.stdout, policy) {
            Ok(_) => (),
            Err(problem) => {
                return problem;
            }
        }
        match event_text_codec_decode(value.stderr, policy) {
            Ok(_) => (),
            Err(problem) => {
                return problem;
            }
        }
    }
    return "";
}

public flow load_rows<A ~ CheckAccess>(
    row: Option<MemoryEntry<string, Frame>>,
    access: A,
    policy: Policy,
    binding: string
) -> Result<Option<MemoryEntry<string, Frame>>, string> {
    let work = match access.work() {
        Ok(Some(item)) => item,
        Ok(None()) => {
            if row != None() {
                return Err("check exists without work");
            }
            return Ok(None());
        }
        Err(problem) => {
            return Err(problem);
        }
    };
    match row {
        Some(item) => {
            let error = check_store_invalid(item.value, policy, binding);
            if error != "" {
                return Err(error);
            }
            let saved = item.value;
            if item.key != "check" || saved.check.id != work.id || saved.workspace != work.workspace
                || saved.path != work.path || saved.work_history != work.history_version {
                return Err("check and work bindings differ");
            }
            if saved.check.phase != "planned" {
                if work.phase != "complete" {
                    return Err("check requires completed work");
                }
                let edit = access.completed_edit(saved.check.id, saved.workspace, saved.path);
                if edit != "" {
                    return Err(edit);
                }
            }
        }
        None() => (),
    }
    return Ok(row);
}

public flow write_rows<R ~ CasRows<Frame>>(
    rows: R,
    value: Frame,
    expected: Option<MemoryEntry<string, Frame>>,
    policy: Policy,
    binding: string
) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let error = check_store_invalid(value, policy, binding);
    if error != "" {
        return Err(error);
    }
    let before = match rows.read() {
        Ok(item) => item,
        Err(problem) => {
            return Err(problem);
        }
    };
    if before != expected {
        return Err("recoverable check changed; no retry");
    }
    let condition: WriteCondition = match expected {
        Some(item) => WriteCondition.Match(item.version),
        None() => Missing
    };
    let previous = match expected {
        Some(item) => Some(item.version),
        None() => None()
    };
    return commit_once<Frame, R>(rows, value, condition, previous);
}

public flow plan_rows<R ~ CasRows<Frame>>(
    rows: R,
    work: Record,
    digest: string,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match rows.read() {
        Ok(None()) => (),
        Ok(Some(_)) => {
            return Err("check already planned; no retry");
        }
        Err(error) => {
            return Err(error);
        }
    }
    let record = history_check_store_Record {
        format = 1,
        phase = "planned",
        id = work.id,
        digest,
        outcome = "",
        exit_code = ""
    };
    let frame = Frame {
        format = 1,
        policy_binding = binding,
        work_history = work.history_version,
        workspace = work.workspace,
        path = work.path,
        check = record,
        stdout = "",
        stderr = "",
        stdout_truncated = false,
        stderr_truncated = false
    };
    match write_rows(rows, frame, None(), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    }
}

public flow start_rows<R ~ CasRows<Frame>, A ~ CheckAccess>(
    rows: R,
    access: A,
    id: string,
    digest: string,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let before = match rows.read() {
        Ok(Some(item)) => item,
        _ => {
            return Err("planned check missing or invalid");
        }
    };
    let old = before.value;
    if old.check.id != id || old.check.digest != digest || old.check.phase != "planned" {
        return Err("planned check differs; no retry");
    }
    let work = match access.work() {
        Ok(Some(item)) => item,
        _ => {
            return Err("completed work missing");
        }
    };
    if work.phase != "complete" {
        return Err("completed work required");
    }
    let edit = access.completed_edit(id, old.workspace, old.path);
    if edit != "" {
        return Err(edit);
    }
    let record = history_check_store_Record {
        format = 1,
        phase = "running",
        id,
        digest,
        outcome = "",
        exit_code = ""
    };
    let frame = old {
        format = 1,
        policy_binding = binding,
        check = record,
        stdout = "",
        stderr = "",
        stdout_truncated = false,
        stderr_truncated = false
    };
    match write_rows(rows, frame, Some(before), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    }
}

public flow finish_rows<R ~ CasRows<Frame>>(
    rows: R,
    id: string,
    digest: string,
    outcome: string,
    exit_code: string,
    stdout: string,
    stderr: string,
    out_truncated: bool,
    err_truncated: bool,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let before = match rows.read() {
        Ok(Some(item)) => item,
        _ => {
            return Err("running check missing or invalid");
        }
    };
    let old = before.value;
    if old.check.id != id || old.check.digest != digest || old.check.phase != "running" {
        return Err("running check differs; no retry");
    }
    let out = match encode_prefix(stdout, out_truncated, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let err = match encode_prefix(stderr, err_truncated, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let record = history_check_store_Record {
        format = 1,
        phase = "complete",
        id,
        digest,
        outcome,
        exit_code
    };
    let frame = old {
        format = 1,
        policy_binding = binding,
        check = record,
        stdout = out.value,
        stderr = err.value,
        stdout_truncated = out.truncated,
        stderr_truncated = err.truncated
    };
    match write_rows(rows, frame, Some(before), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    }
}

public flow abandon_rows<R ~ CasRows<Frame>>(rows: R, id: string, policy: Policy, binding: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let before = match rows.read() {
        Ok(Some(item)) => item,
        _ => {
            return Err("running check missing");
        }
    };
    let old = before.value;
    if old.check.id != id || old.check.phase != "running" {
        return Err("interrupted check identity or phase differs");
    }
    let record = old.check {
        phase = "abandoned",
        outcome = "",
        exit_code = ""
    };
    let frame = old {
        check = record
    };
    return match write_rows(rows, frame, Some(before), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow history_check_guard_invalid(value: history_check_store_Record) -> string {
    return invalid_values(
        value.format,
        value.phase,
        value.id,
        value.digest,
        value.outcome,
        value.exit_code,
        true
    );
}

public flow history_check_guard_plan(ticket: HistoricalWorkTicket, digest: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    match historical_work_claim(ticket) {
        Ok(_) => plan(FirstCheckRows {}, ticket.record.id, digest),
        Err(error) => Err(error)
    }
}

public flow history_check_guard_start(id: string, digest: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return start(FirstCheckRows {}, id, digest);
}

public flow history_check_guard_finish(id: string, digest: string, outcome: string, exit_code: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_check_store_finish(FirstCheckRows {}, id, digest, outcome, exit_code);
}

public flow inspect() -> Result<Option<history_check_store_Record>, string> {
    return history_check_store_inspect(FirstCheckRows {});
}

public type FirstCheckRows = {};

impl FirstCheckRows ~ HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, history_check_store_Record>> {
        return Checks.Rows.get_entry("check");
    }

    flow write(self, row: history_check_store_Record, condition: WriteCondition) -> Result<
        MemoryVersion,
        string
    > ![Memory, Error<StorageError>, Error<IndexError>] {
        return commit_native<history_check_store_Record>(
            Checks.Rows,
            Target {
                store = ["Rows"],
                region = "nomo-history-check-v1",
                key = "check",
                label = "history-check"
            },
            row,
            condition
        );
    }

    flow confirmed_work(self, id: string) -> string {
        let work = match work_admission_inspect() {
            Ok(Some(value)) => value,
            _ => {
                return "completed work record required";
            }
        };
        if work.phase != "complete" || work.id != id {
            return "completed work identity required";
        }
        let edit = match edit_operation_store_inspect(work.id, work.workspace, work.path) {
            Ok(Some(value)) => value,
            _ => {
                return "completed edit record required";
            }
        };
        return if edit.phase == "completed" {
            ""
        } else {
            "completed edit record required"
        };
    }

    flow recorded_work_id(self) -> Result<string, string> {
        return match work_admission_inspect() {
            Ok(Some(value)) => Ok(value.id),
            _ => Err("history-check has no work record")
        };
    }

    flow allow_abandoned(self) -> bool ![] {
        return true;
    }
}

public type FirstCheckAdapter = {
    redaction: Policy,
    binding: string
};

impl FirstCheckAdapter ~ CasRows<Frame> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-recoverable-check-v1",
            key = "check",
            label = "check"
        };
    }

    flow submit(self, value: Frame, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] {
        return submit_native(recoverable_check_store_Checks.Rows, "check", value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, Frame>>, string> {
        return load(self.redaction, self.binding);
    }

    flow same(self, left: Frame, right: Frame) -> bool ![] {
        return left == right;
    }
}

impl FirstCheckAdapter ~ CheckAccess {
    flow work(self) -> Result<Option<Record>, string> {
        return match recoverable_work_store_load(self.redaction, self.binding) {
            Ok(Some(item)) => Ok(Some(item.value.work)),
            Ok(None()) => Ok(None()),
            Err(error) => Err(error)
        };
    }

    flow completed_edit(self, id: string, workspace: string, path: string) -> string {
        let edit = match edit_operation_store_inspect(id, workspace, path) {
            Ok(Some(item)) => item,
            _ => {
                return "completed edit required";
            }
        };
        return if edit.phase == "completed" {
            ""
        } else {
            "completed edit required"
        };
    }
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return load_rows(
        recoverable_check_store_Checks.Rows.get_entry("check"),
        FirstCheckAdapter {
            redaction = policy,
            binding
        },
        policy,
        binding
    );
}

public flow recoverable_check_store_plan(ticket: Ticket, digest: string, policy: Policy, binding: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match recoverable_work_store_claim(ticket, policy, binding) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let rows = FirstCheckAdapter {
        redaction = policy,
        binding
    };
    return plan_rows(rows, ticket.frame.work, digest, policy, binding);
}

public flow recoverable_check_store_start(id: string, digest: string, policy: Policy, binding: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let rows = FirstCheckAdapter {
        redaction = policy,
        binding
    };
    return start_rows(rows, rows, id, digest, policy, binding);
}

public flow recoverable_check_store_finish(
    id: string,
    digest: string,
    outcome: string,
    exit_code: string,
    stdout: string,
    stderr: string,
    out_truncated: bool,
    err_truncated: bool,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let rows = FirstCheckAdapter {
        redaction = policy,
        binding
    };
    return finish_rows(
        rows,
        id,
        digest,
        outcome,
        exit_code,
        stdout,
        stderr,
        out_truncated,
        err_truncated,
        policy,
        binding
    );
}

public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let rows = FirstCheckAdapter {
        redaction = policy,
        binding
    };
    return abandon_rows(rows, id, policy, binding);
}
