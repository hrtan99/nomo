module nomo.application.transfer.ports;

import std.fs.{WorkspacePath, ReadLimitError, IOError as FileError};
import std.effects.Fs;
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.transfer.copy.CopyJob;
import nomo.domain.transfer.archive.{ArchiveDocument, Imported, ExportPreview};

public spec CopyRepository {
    flow lookup(self, id: string) -> Option<CopyJob> ![Memory, Error<StorageError>];
    flow list(self, workspace: string) -> Array<CopyJob> ![Memory, Error<StorageError>];
    flow prepare(self, workspace: string, title: string, kind: string, source: string, digest: bytes, total: i64) -> CopyJob ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow ensure_session(self, id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow advance(self, id: string, cursor: i64, phase: string) -> CopyJob ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow event(self, id: string, index: i64, role: string, name: string, text: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow sealed(self, id: string) -> Option<string> ![Memory, Error<StorageError>];
    flow summary(self, id: string, slot: i64) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow complete(self, id: string, index: i64) -> bool ![Memory, Error<StorageError>];
}
public spec ArchiveWorkspace {
    flow target(self, path: string) -> WorkspacePath<ProjectRoot> ![];
    flow read(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
    flow replace(self, target: WorkspacePath<ProjectRoot>, text: string) -> unit ![Fs.atomic_replace<ProjectRoot>, Error<FileError>];
}
public spec ArchiveEncoding {
    flow encode(self, value: ArchiveDocument) -> string ![];
    flow decode(self, raw: string) -> Imported ![];
    flow fingerprint(self, raw: string) -> bytes ![];
}
public spec TransferRenderer {
    flow progress(self, id: string, copied: i64, total: i64) -> unit ![Console, Error<ConsoleError>];
    flow preview(self, value: ExportPreview) -> unit ![Console, Error<ConsoleError>];
    flow exported(self, path: string) -> unit ![Console, Error<ConsoleError>];
}
