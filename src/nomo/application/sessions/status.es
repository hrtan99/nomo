module nomo.application.sessions.status;




// Status readers are read-only projections. Renderers receive typed data and
// never infer authority, current workspace identity or effect completion.
public spec SessionStatusReader<Snapshot> {
    flow snapshot(self) -> Result<Snapshot, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}
