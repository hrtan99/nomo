module nomo.application.sessions.ports.session_check_store;

import nomo.session.history_work_guard.Record as Work;

// Storage layouts and admission proofs stay in their concrete adapters.
public spec CheckAccess {
    flow work(self) -> Result<Option<Work>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow completed_edit(self, id: string, workspace: string, path: string) -> string ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}
