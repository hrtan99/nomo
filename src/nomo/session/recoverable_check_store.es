module nomo.session.recoverable_check_store;

import std.memory.{get_entry, MemoryEntry, WriteCondition};
import nomo.session.redaction.Policy;
import nomo.session.cas_rows.{CasRows, Target, Submission, submit_native};
public import nomo.session.check_store.{Frame, invalid};
import nomo.session.check_store.{CheckAccess, load_rows, plan_rows, start_rows, finish_rows, abandon_rows};
import nomo.session.recoverable_work_store.{Ticket, claim, load as load_work};
import nomo.session.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_work_guard.Record as Work;

alias Schema = MemoryRegion<{ Rows: Store<string, Frame> }>;
let Checks = std.memory.region<Schema>(stable_id = "nomo-recoverable-check-v1", store = "recoverable-check");

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
public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> {
    return load_rows(get_entry(Checks.Rows, "check"), FirstCheckAdapter { redaction = policy, binding = binding }, policy, binding);
}
public flow plan(ticket: Ticket, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return Err(error); } }
    let rows = FirstCheckAdapter { redaction = policy, binding = binding };
    return plan_rows(rows, ticket.frame.work, digest, policy, binding);
}
public flow start(id: string, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let rows = FirstCheckAdapter { redaction = policy, binding = binding };
    return start_rows(rows, rows, id, digest, policy, binding);
}
public flow finish(id: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let rows = FirstCheckAdapter { redaction = policy, binding = binding };
    return finish_rows(rows, id, digest, outcome, exit_code, stdout, stderr, out_truncated, err_truncated, policy, binding);
}
public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let rows = FirstCheckAdapter { redaction = policy, binding = binding };
    return abandon_rows(rows, id, policy, binding);
}
