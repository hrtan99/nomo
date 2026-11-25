module nomo.application.native.transfer.effects;

import nomo.native.history.{CopyJob, Session};
import std.fs.WorkspacePath;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.transfer.archive.{ArchiveDocument, Imported, ExportPreview};

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
