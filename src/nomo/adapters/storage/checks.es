module nomo.adapters.storage.checks;

import nomo.domain.sessions.work.{WorkPhase};
import nomo.domain.sessions.work.{CheckState, CheckOutcome};
import nomo.domain.editing.LiteralEditPhase;
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
import nomo.application.sessions.ports.{CasRows, CheckAccess, HistoricalWorkTicket, HistoryCheckRows, Submission, Target};
import nomo.domain.sessions.event_codec.{Policy, encode_prefix, event_text_codec_decode};
import nomo.domain.sessions.work.{CapturedCheckAttempt, CheckAttempt, WorkAttempt, invalid_values};
import std.memory.{MemoryEntry, MemoryVersion, Missing, WriteCondition};

public flow check_store_invalid(value: CapturedCheckAttempt, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding || value.work_history == ""
        || value.workspace == "" || value.path == "" {
        return "invalid recoverable check binding";
    }
    let error = history_check_guard_invalid(value.check);
    if error != "" {
        return error;
    }
    if !value.check.phase.is_complete() {
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
    row: Option<MemoryEntry<string, CapturedCheckAttempt>>,
    access: A,
    policy: Policy,
    binding: string
) -> Result<Option<MemoryEntry<string, CapturedCheckAttempt>>, string> {
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
            if saved.check.phase != CheckState.Planned {
                if work.phase != WorkPhase.Complete {
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

public flow write_rows<R ~ CasRows<CapturedCheckAttempt>>(
    rows: R,
    value: CapturedCheckAttempt,
    expected: Option<MemoryEntry<string, CapturedCheckAttempt>>,
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
    return commit_once<CapturedCheckAttempt, R>(rows, value, condition, previous);
}

public flow plan_rows<R ~ CasRows<CapturedCheckAttempt>>(
    rows: R,
    work: WorkAttempt,
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
    let record = CheckAttempt {
        format = 1,
        phase = CheckState.Planned,
        id = work.id,
        digest,
    };
    let frame = CapturedCheckAttempt {
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

public flow start_rows<R ~ CasRows<CapturedCheckAttempt>, A ~ CheckAccess>(
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
    if old.check.id != id || old.check.digest != digest || old.check.phase != CheckState.Planned {
        return Err("planned check differs; no retry");
    }
    let work = match access.work() {
        Ok(Some(item)) => item,
        _ => {
            return Err("completed work missing");
        }
    };
    if work.phase != WorkPhase.Complete {
        return Err("completed work required");
    }
    let edit = access.completed_edit(id, old.workspace, old.path);
    if edit != "" {
        return Err(edit);
    }
    let record = CheckAttempt {
        format = 1,
        phase = CheckState.Running,
        id,
        digest,
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

public flow finish_rows<R ~ CasRows<CapturedCheckAttempt>>(
    rows: R,
    id: string,
    digest: string,
    outcome: CheckOutcome,
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
    if old.check.id != id || old.check.digest != digest || old.check.phase != CheckState.Running {
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
    let record = CheckAttempt {
        format = 1,
        phase = CheckState.Complete(outcome),
        id,
        digest
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

public flow abandon_rows<R ~ CasRows<CapturedCheckAttempt>>(
    rows: R,
    id: string,
    policy: Policy,
    binding: string
) -> Result<
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
    if old.check.id != id || old.check.phase != CheckState.Running {
        return Err("interrupted check identity or phase differs");
    }
    let record = old.check {
        phase = CheckState.Abandoned
    };
    let frame = old {
        check = record
    };
    return match write_rows(rows, frame, Some(before), policy, binding) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow history_check_guard_invalid(value: CheckAttempt) -> string {
    return invalid_values(
        value.format,
        value.phase,
        value.id,
        value.digest,
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

public flow history_check_guard_finish(id: string, digest: string, outcome: CheckOutcome) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_check_store_finish(FirstCheckRows {}, id, digest, outcome,);
}

public flow inspect() -> Result<Option<CheckAttempt>, string> {
    return history_check_store_inspect(FirstCheckRows {});
}

public type FirstCheckRows = {};

impl FirstCheckRows ~ HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, CheckAttempt>> {
        return HistoryChecks.Rows.get_entry("check");
    }

    flow write(self, row: CheckAttempt, condition: WriteCondition) -> Result<
        MemoryVersion,
        string
    > ![Memory, Error<StorageError>, Error<IndexError>] {
        return commit_native<CheckAttempt>(
            HistoryChecks.Rows,
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
        if work.phase != WorkPhase.Complete || work.id != id {
            return "completed work identity required";
        }
        let edit = match edit_operation_store_inspect(work.id, work.workspace, work.path) {
            Ok(Some(value)) => value,
            _ => {
                return "completed edit record required";
            }
        };
        return if edit.phase == LiteralEditPhase.Completed {
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

impl FirstCheckAdapter ~ CasRows<CapturedCheckAttempt> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-recoverable-check-v1",
            key = "check",
            label = "check"
        };
    }

    flow submit(self, value: CapturedCheckAttempt, condition: WriteCondition) -> Submission ![
        Memory,
        Error<StorageError>
    ] {
        return submit_native(RecoverableChecks.Rows, "check", value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, CapturedCheckAttempt>>, string> {
        return load(self.redaction, self.binding);
    }

    flow same(self, left: CapturedCheckAttempt, right: CapturedCheckAttempt) -> bool ![] {
        return left == right;
    }
}

impl FirstCheckAdapter ~ CheckAccess {
    flow work(self) -> Result<Option<WorkAttempt>, string> {
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
        return if edit.phase == LiteralEditPhase.Completed {
            ""
        } else {
            "completed edit required"
        };
    }
}

public flow load(policy: Policy, binding: string) -> Result<
    Option<MemoryEntry<string, CapturedCheckAttempt>>,
    string
> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return load_rows(
        RecoverableChecks.Rows.get_entry("check"),
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
    outcome: CheckOutcome,
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

alias HistoryChecksSchema = MemoryRegion<{
    Rows: Store<string, CheckAttempt>
}>;

public let HistoryChecks = std.memory.region<HistoryChecksSchema>(
    stable_id = "nomo-history-check-v1",
    store = "history-check"
);

alias RecoverableChecksSchema = MemoryRegion<{
    Rows: Store<string, CapturedCheckAttempt>
}>;

public let RecoverableChecks = std.memory.region<RecoverableChecksSchema>(
    stable_id = "nomo-recoverable-check-v1",
    store = "recoverable-check"
);
