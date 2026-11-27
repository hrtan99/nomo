module nomo.adapters.storage.legacy.history_followup_guard;

import std.memory.{WriteCondition, MemoryEntry};
import nomo.application.sessions.history_followup;
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.application.sessions.ports.prior_chat.PriorChatReader;
import nomo.application.sessions.ports.followup_predecessors.FollowupPredecessors;
import nomo.domain.sessions.cas_rows.{Target, Submission};
import nomo.adapters.storage.legacy.cas_rows.submit_native;
import nomo.domain.sessions.chat_history.Entry;
import nomo.adapters.storage.legacy.chat_history.load as load_chat;
import nomo.adapters.storage.legacy.history_work_guard.inspect as inspect_work;
import nomo.adapters.storage.legacy.history_check_guard.inspect as inspect_check;
import nomo.adapters.storage.legacy.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_work_guard.Record as WorkRecord;
import nomo.session.history_check_store.Record as CheckRecord;
import nomo.session.edit_operation.Record as EditRecord;
import nomo.session.history_followup_guard.{Record, Parent, Runs};
import nomo.domain.sessions.history_followup_guard.Ticket;
import nomo.harness.harness_work_contract.Ledger;

public type NativeHistoryFollowup = {};
impl NativeHistoryFollowup ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-history-followup-v1", key = "followup", label = "followup" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Runs.Rows, "followup", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(Runs.Rows.get_entry("followup")); }
    flow same(self, left: Record, right: Record) -> bool ![] { return left == right; }
}
impl NativeHistoryFollowup ~ PriorChatReader {
    flow load(self) -> Result<Option<Entry>, string> { return load_chat(); }
}
impl NativeHistoryFollowup ~ FollowupPredecessors {
    flow work(self) -> Result<Option<WorkRecord>, string> { return inspect_work(); }
    flow edit(self, id: string, workspace: string, path: string) -> Result<Option<EditRecord>, string> { return inspect_edit(id, workspace, path); }
    flow check(self) -> Result<Option<CheckRecord>, string> { return inspect_check(); }
}

public flow parent() -> Result<Parent, string> { return history_followup.parent(NativeHistoryFollowup {}); }
public flow admit(id: string, workspace: string, path: string, request: string, history: Entry) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_followup.admit(NativeHistoryFollowup {}, id, workspace, path, request, history);
}
public flow claim(ticket: Ticket) -> Result<bool, string> { return history_followup.claim(NativeHistoryFollowup {}, ticket); }
public flow finish(ticket: Ticket, summary: string, spent: Ledger) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_followup.finish(NativeHistoryFollowup {}, ticket, summary, spent);
}
public flow inspect() -> Result<Option<Record>, string> { return history_followup.inspect(NativeHistoryFollowup {}); }
