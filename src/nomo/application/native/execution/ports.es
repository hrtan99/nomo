module nomo.application.native.execution.ports;

import nomo.native.lifecycle.Attempt;

public spec AttemptRepository {
    flow list(self, session: string, unresolved: bool) -> Array<Attempt> ![Memory, Error<StorageError>];
    flow load(self, id: string) -> Attempt ![Memory, Error<StorageError>];
    flow prepare(self, session: string, kind: string, label: string, input_event: i64, through: i64) -> Attempt ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow update(self, id: string, phase: string, result_event: i64, recovery_event: i64) -> Attempt ![Memory, Error<StorageError>, Error<MemoryConflict>];
}
