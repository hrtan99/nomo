module nomo.adapters.storage.legacy.history_work_guard;

import std.memory.{WriteCondition, MemoryEntry};
import nomo.application.sessions.history_work;
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.application.sessions.ports.prior_chat.PriorChatReader;
import nomo.domain.sessions.cas_rows.{Target, Submission};
import nomo.adapters.storage.legacy.cas_rows.submit_native;
import nomo.domain.sessions.chat_history.Entry;
import nomo.adapters.storage.legacy.chat_history.load as load_chat;
import nomo.session.history_work_guard.{Record, Runs};
import nomo.domain.sessions.history_work_guard.Ticket;
import nomo.harness.harness_work_contract.Ledger;

public type NativeHistoryWork = {};

impl NativeHistoryWork ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-history-work-v1", key = "work", label = "history-work" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Runs.Rows, "work", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(Runs.Rows.get_entry("work")); }
    flow same(self, left: Record, right: Record) -> bool ![] { return left == right; }
}
impl NativeHistoryWork ~ PriorChatReader {
    flow load(self) -> Result<Option<Entry>, string> { return load_chat(); }
}

public flow admit(id: string, workspace: string, path: string, request: string, history: Entry) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_work.admit(NativeHistoryWork {}, id, workspace, path, request, history);
}
public flow claim(ticket: Ticket) -> Result<bool, string> {
    return history_work.claim(NativeHistoryWork {}, ticket);
}
public flow finish(ticket: Ticket, summary: string, spent: Ledger) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    return history_work.finish(NativeHistoryWork {}, ticket, summary, spent);
}
public flow chat_available() -> Result<bool, string> {
    return history_work.chat_available(NativeHistoryWork {});
}
public flow inspect() -> Result<Option<Record>, string> {
    return history_work.inspect(NativeHistoryWork {});
}
