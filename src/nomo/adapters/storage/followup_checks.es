module nomo.adapters.storage.followup_checks;

import nomo.adapters.storage.checks.{abandon_rows, finish_rows, load_rows, plan_rows, start_rows};
import nomo.adapters.storage.edits.history_followup_edit_store_inspect;
import nomo.adapters.storage.followup.{
    Ticket,
    historical_followup_claim,
    inspect as followup_inspect,
    load as followup_load,
    recoverable_followup_store_claim
};
import nomo.adapters.storage.session_records.{commit_native, submit_native};
import nomo.application.sessions.admission.{history_check_store_finish, history_check_store_inspect, plan, start};
import nomo.application.sessions.ports.{
    CasRows,
    CheckAccess,
    HistoricalFollowupTicket,
    HistoryCheckRows,
    Submission,
    Target
};
import nomo.domain.sessions.event_codec.Policy;
import nomo.session.check_store.Frame;
import nomo.session.history_check_store.Record;
import nomo.session.history_followup_check_guard.Checks;
import nomo.session.history_work_guard.Record as history_work_guard_Record;
import nomo.session.recoverable_followup_check_store.Checks as recoverable_followup_check_store_Checks;
import std.memory.{MemoryEntry, MemoryVersion, WriteCondition};

type FollowupCheckRows = {};

impl FollowupCheckRows ~ HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, Record>> {
        return Checks.Rows.get_entry("check");
    }

    flow write(self, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>
    ] {
        return commit_native<Record>(
            Checks.Rows,
            Target {
                store = ["Rows"],
                region = "nomo-followup-check-v1",
                key = "check",
                label = "history-check"
            },
            row,
            condition
        );
    }

    flow confirmed_work(self, id: string) -> string {
        let work = match followup_inspect() {
            Ok(Some(value)) => value,
            _ => {
                return "completed work record required";
            }
        };
        if work.phase != "complete" || work.id != id {
            return "completed work identity required";
        }
        let edit = match history_followup_edit_store_inspect(work.id, work.workspace, work.path) {
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
        return match followup_inspect() {
            Ok(Some(value)) => Ok(value.id),
            _ => Err("history-check has no work record")
        };
    }

    flow allow_abandoned(self) -> bool ![] {
        return false;
    }
}

public flow history_followup_check_guard_plan(ticket: HistoricalFollowupTicket, digest: string) -> Result<
    bool,
    string
> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match historical_followup_claim(ticket) {
        Ok(_) => plan(FollowupCheckRows {}, ticket.record.id, digest),
        Err(error) => Err(error)
    }
}

public flow history_followup_check_guard_start(id: string, digest: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return start(FollowupCheckRows {}, id, digest);
}

public flow history_followup_check_guard_finish(
    id: string,
    digest: string,
    outcome: string,
    exit_code: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_check_store_finish(FollowupCheckRows {}, id, digest, outcome, exit_code);
}

public flow inspect() -> Result<Option<Record>, string> {
    return history_check_store_inspect(FollowupCheckRows {});
}

public type FollowupCheckAdapter = {
    redaction: Policy,
    binding: string
};

impl FollowupCheckAdapter ~ CasRows<Frame> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-recoverable-followup-check-v1",
            key = "check",
            label = "check"
        };
    }

    flow submit(self, value: Frame, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] {
        return submit_native(recoverable_followup_check_store_Checks.Rows, "check", value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, Frame>>, string> {
        return load(self.redaction, self.binding);
    }

    flow same(self, left: Frame, right: Frame) -> bool ![] {
        return left == right;
    }
}

impl FollowupCheckAdapter ~ CheckAccess {
    flow work(self) -> Result<Option<history_work_guard_Record>, string> {
        return match followup_load(self.redaction, self.binding) {
            Ok(Some(item)) => Ok(Some(item.value.work)),
            Ok(None()) => Ok(None()),
            Err(error) => Err(error)
        };
    }

    flow completed_edit(self, id: string, workspace: string, path: string) -> string {
        let edit = match history_followup_edit_store_inspect(id, workspace, path) {
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
        recoverable_followup_check_store_Checks.Rows.get_entry("check"),
        FollowupCheckAdapter {
            redaction = policy,
            binding
        },
        policy,
        binding
    );
}

public flow recoverable_followup_check_store_plan(
    ticket: Ticket,
    digest: string,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match recoverable_followup_store_claim(ticket, policy, binding) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let rows = FollowupCheckAdapter {
        redaction = policy,
        binding
    };
    return plan_rows(rows, ticket.frame.work, digest, policy, binding);
}

public flow recoverable_followup_check_store_start(
    id: string,
    digest: string,
    policy: Policy,
    binding: string
) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let rows = FollowupCheckAdapter {
        redaction = policy,
        binding
    };
    return start_rows(rows, rows, id, digest, policy, binding);
}

public flow recoverable_followup_check_store_finish(
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
    let rows = FollowupCheckAdapter {
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
    let rows = FollowupCheckAdapter {
        redaction = policy,
        binding
    };
    return abandon_rows(rows, id, policy, binding);
}
