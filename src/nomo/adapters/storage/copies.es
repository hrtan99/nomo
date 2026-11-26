module nomo.adapters.storage.copies;

import nomo.domain.transfer.copy.CopyJob;
import nomo.application.transfer.ports.CopyRepository;
import nomo.adapters.storage.conversations.{copy_status, copy_jobs, prepare_copy, ensure_copy_session, advance_copy, copy_event, sealed_copy_source, copy_summary, copy_record_complete};

public type NativeCopies = {};
impl NativeCopies ~ CopyRepository {
    flow lookup(self, id: string) -> Option<CopyJob> ![Memory, Error<StorageError>] { return copy_status(id); }
    flow list(self, workspace: string) -> Array<CopyJob> ![Memory, Error<StorageError>] { return copy_jobs(workspace); }
    flow prepare(self, workspace: string, title: string, kind: string, source: string, digest: bytes, total: i64) -> CopyJob ![Memory, Error<StorageError>, Error<MemoryConflict>] { return prepare_copy(workspace, title, kind, source, digest, total); }
    flow ensure_session(self, id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { ensure_copy_session(id); }
    flow advance(self, id: string, cursor: i64, phase: string) -> CopyJob ![Memory, Error<StorageError>, Error<MemoryConflict>] { return advance_copy(id, cursor, phase); }
    flow event(self, id: string, index: i64, role: string, name: string, text: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { copy_event(id, index, role, name, text); }
    flow sealed(self, id: string) -> Option<string> ![Memory, Error<StorageError>] { return sealed_copy_source(id); }
    flow summary(self, id: string, slot: i64) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { copy_summary(id, slot); }
    flow complete(self, id: string, index: i64) -> bool ![Memory, Error<StorageError>] { return copy_record_complete(id, index); }
}
