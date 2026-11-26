module nomo.adapters.storage.legacy_work_timeline;

import nomo.application.work.ports.WorkTimeline;
import nomo.domain.work.protocol.{Pending, Summary};
import nomo.core.conversation.Event;
import nomo.domain.sessions.redaction.Policy;
import nomo.domain.mutations.edit_contract.Confirmed;

public type LegacyWorkTimeline = {};
impl LegacyWorkTimeline ~ WorkTimeline {
    flow enabled(self) -> bool ![] { return false; }
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>] { return Err("legacy work has no event timeline"); }
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return Err("legacy work has no event timeline"); }
}
