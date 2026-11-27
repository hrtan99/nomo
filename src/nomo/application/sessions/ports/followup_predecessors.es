module nomo.application.sessions.ports.followup_predecessors;

import nomo.session.history_work_guard.Record as WorkRecord;
import nomo.session.history_check_store.Record as CheckRecord;
import nomo.session.edit_operation.Record as EditRecord;

public spec FollowupPredecessors {
    flow work(self) -> Result<Option<WorkRecord>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow edit(self, id: string, workspace: string, path: string) -> Result<Option<EditRecord>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow check(self) -> Result<Option<CheckRecord>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}
