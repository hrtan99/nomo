module nomo.application.sessions.ports.session_history_check_store;

import std.memory.{WriteCondition, MemoryVersion, MemoryEntry};
import nomo.session.history_check_store.Record;

public spec HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, Record>> ![Memory, Error<StorageError>, Error<IndexError>];
    flow write(self, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow confirmed_work(self, id: string) -> string ![Memory, Error<StorageError>, Error<IndexError>];
    flow recorded_work_id(self) -> Result<string, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow allow_abandoned(self) -> bool ![];
}
