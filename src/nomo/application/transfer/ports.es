module nomo.application.transfer.ports;

import nomo.application.migration.ports.MigrationRoot;
import nomo.domain.archives.{ArchiveDocument, ExportPreview, Imported, NativeImage, NativeRecord, ProjectImage};
import nomo.native.history.{CopyJob, Session};
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError, WorkspacePath};
import std.io.IOError;

public spec NativeStateSource {
    flow load(self) -> NativeImage ![Fs.read<MigrationRoot>, Error<fs_IOError>, Error<ReadLimitError>, Error<IndexError>];
}

public spec NativeStateDestination {
    flow insert(self, record: NativeRecord) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}

public spec ProjectStateSource {
    flow load(self) -> ProjectImage ![Fs.read<MigrationRoot>, Error<fs_IOError>, Error<ReadLimitError>, Error<IndexError>];
}

public spec HistoricalEvents {
    flow append(self, session: string, role: string, name: string, text: string) -> i64
        ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
}

public effect ArchiveFiles {
    action target(path: string) -> WorkspacePath<ProjectRoot>;
    action read(path: string) -> string;
    action replace(target: WorkspacePath<ProjectRoot>, text: string) -> unit;
}

public effect CopyStorage {
    action lookup(id: string) -> Option<CopyJob>;
    action list(workspace: string) -> Array<CopyJob>;
    action prepare(workspace: string, title: string, kind: string, source: string, digest: bytes, total: i64) -> CopyJob;
    action ensure_session(id: string) -> unit;
    action advance(id: string, cursor: i64, phase: string) -> CopyJob;
    action event(id: string, index: i64, role: string, name: string, text: string) -> unit;
    action sealed(id: string) -> Option<string>;
    action summary(id: string, slot: i64) -> unit;
    action complete(id: string, index: i64) -> bool;
}

public effect ArchiveCodec {
    action encode(document: ArchiveDocument) -> string;
    action decode(raw: string) -> Imported;
    action fingerprint(raw: string) -> bytes;
}

public effect TransferDisplay {
    action progress(id: string, copied: i64, total: i64) -> unit;
    action preview(value: ExportPreview) -> unit;
    action exported(path: string) -> unit;
}

public effect TransferOperations {
    action save(session: string, path: string) -> unit;
    action load(workspace: string, path: string) -> Session;
    action resume_import(workspace: string, id: string) -> Session;
    action fork(session: string, through: i64) -> Session;
    action resume_fork(workspace: string, id: string) -> Session;
    action discard(workspace: string, id: string) -> unit;
    action status(id: string) -> Option<CopyJob>;
    action copies(workspace: string) -> Array<CopyJob>;
    action job(id: string) -> CopyJob;
}

public spec CopyRepository {
    flow lookup(self, id: string) -> Option<CopyJob> ![Memory, Error<StorageError>];
    flow list(self, workspace: string) -> Array<CopyJob> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
    flow prepare(self, workspace: string, title: string, kind: string, source: string, digest: bytes, total: i64) -> CopyJob ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow ensure_session(self, id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow advance(self, id: string, cursor: i64, phase: string) -> CopyJob ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow event(self, id: string, index: i64, role: string, name: string, text: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
    flow sealed(self, id: string) -> Option<string> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
    flow summary(self, id: string, slot: i64) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow complete(self, id: string, index: i64) -> bool ![Memory, Error<StorageError>];
}

public spec ArchiveWorkspace {
    flow target(self, path: string) -> WorkspacePath<ProjectRoot> ![];
    flow read(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<fs_IOError>, Error<ReadLimitError>];
    flow replace(self, target: WorkspacePath<ProjectRoot>, text: string) -> unit ![Fs.atomic_replace<ProjectRoot>, Error<fs_IOError>];
}

public spec ArchiveEncoding {
    flow encode(self, value: ArchiveDocument) -> string ![];
    flow decode(self, raw: string) -> Imported ![];
    flow fingerprint(self, raw: string) -> bytes ![];
}

public spec TransferRenderer {
    flow progress(self, id: string, copied: i64, total: i64) -> unit ![Console, Error<IOError>];
    flow preview(self, value: ExportPreview) -> unit ![Console, Error<IOError>];
    flow exported(self, path: string) -> unit ![Console, Error<IOError>];
}
