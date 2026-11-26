module nomo.adapters.storage.work_timeline;

import std.memory.MemoryEntry;
import nomo.application.work.ports.WorkTimeline;
import nomo.domain.work.protocol.{Pending, Summary};
import nomo.core.conversation.Event;
import nomo.domain.sessions.redaction.Policy;
import nomo.session.recoverable_chat_store.Frame as ChatFrame;
import nomo.adapters.storage.legacy.recoverable_chat_store.record_work_from;
import nomo.domain.sessions.work_fact_events.capture;
import nomo.domain.mutations.edit_contract.Confirmed;

public type EventWorkTimeline = { chat: MemoryEntry<string, ChatFrame> };
impl EventWorkTimeline ~ WorkTimeline {
    flow enabled(self) -> bool ![] { return true; }
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return capture(pending, confirmed, summary);
    }
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return record_work_from(self.chat, id, records, policy, binding);
    }
}
