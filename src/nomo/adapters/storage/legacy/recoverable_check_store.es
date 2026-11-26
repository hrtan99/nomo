module nomo.adapters.storage.legacy.recoverable_check_store;

import std.memory.{MemoryEntry, WriteCondition};
import nomo.domain.sessions.redaction.Policy;
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.domain.sessions.cas_rows.{Target, Submission};
import nomo.adapters.storage.legacy.cas_rows.submit_native;
import nomo.session.check_store.Frame;
import nomo.application.sessions.ports.session_check_store.CheckAccess;
import nomo.adapters.storage.legacy.check_store.{load_rows, plan_rows, start_rows, finish_rows, abandon_rows};
import nomo.domain.sessions.recoverable_work_store.Ticket;
import nomo.adapters.storage.legacy.recoverable_work_store.{claim, load as load_work};
import nomo.adapters.storage.legacy.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_work_guard.Record as Work;
import nomo.session.recoverable_check_store.Checks;

public type FirstCheckAdapter = { redaction: Policy, binding: string };

impl FirstCheckAdapter ~ CasRows<Frame> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-recoverable-check-v1", key = "check", label = "check" }; }
    flow submit(self, value: Frame, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Checks.Rows, "check", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Frame>>, string> { return load(self.redaction, self.binding); }
    flow same(self, left: Frame, right: Frame) -> bool ![] { return left == right; }
}

impl FirstCheckAdapter ~ CheckAccess {
    flow work(self) -> Result<Option<Work>, string> { return match load_work(self.redaction, self.binding) { Ok(Some(item)) => Ok(Some(item.value.work)), Ok(None()) => Ok(None()), Err(error) => Err(error) }; }
    flow completed_edit(self, id: string, workspace: string, path: string) -> string {
        let edit = match inspect_edit(id, workspace, path) { Ok(Some(item)) => item, _ => { return "completed edit required"; } };
        return if edit.phase == "completed" { "" } else { "completed edit required" };
    }
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return load_rows(Checks.Rows.get_entry("check"), FirstCheckAdapter { redaction = policy, binding }, policy, binding);
}

public flow plan(ticket: Ticket, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match claim(ticket, policy, binding) { Ok(_) => (), Err(error) => { return Err(error); } }
    let rows = FirstCheckAdapter { redaction = policy, binding };
    return plan_rows(rows, ticket.frame.work, digest, policy, binding);
}

public flow start(id: string, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let rows = FirstCheckAdapter { redaction = policy, binding };
    return start_rows(rows, rows, id, digest, policy, binding);
}

public flow finish(id: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let rows = FirstCheckAdapter { redaction = policy, binding };
    return finish_rows(rows, id, digest, outcome, exit_code, stdout, stderr, out_truncated, err_truncated, policy, binding);
}

public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let rows = FirstCheckAdapter { redaction = policy, binding };
    return abandon_rows(rows, id, policy, binding);
}
