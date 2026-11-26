module nomo.bootstrap.transfer;

import nomo.application.transfer.service;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.transfer.effects.{CopyStorage, ArchiveFiles, ArchiveCodec, TransferDisplay, TransferOperations};
import nomo.adapters.storage.copies.NativeCopies;
import nomo.adapters.storage.codec.archive_role.JsonArchiveEncoding;
import nomo.adapters.filesystem.archives.ProjectArchives;
import nomo.adapters.cli.transfer.TerminalTransfer;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.attempts.NativeAttempts;

flow bindings() -> ![CopyStorage, ArchiveFiles, ArchiveCodec, TransferDisplay => Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] ![] {
    let copies = NativeCopies {}; let files = ProjectArchives {}; let codec = JsonArchiveEncoding {}; let display = TerminalTransfer {};
    return handler {
        CopyStorage.lookup(id) => copies.lookup(id);
        CopyStorage.list(workspace) => copies.list(workspace);
        CopyStorage.prepare(workspace, title, kind, source, digest, total) => copies.prepare(workspace, title, kind, source, digest, total);
        CopyStorage.ensure_session(id) => copies.ensure_session(id);
        CopyStorage.advance(id, cursor, phase) => copies.advance(id, cursor, phase);
        CopyStorage.event(id, index, role, name, text) => copies.event(id, index, role, name, text);
        CopyStorage.sealed(id) => copies.sealed(id);
        CopyStorage.summary(id, slot) => copies.summary(id, slot);
        CopyStorage.complete(id, index) => copies.complete(id, index);
        ArchiveFiles.target(path) => files.target(path);
        ArchiveFiles.read(path) => files.read(path);
        ArchiveFiles.replace(target, text) => files.replace(target, text);
        ArchiveCodec.encode(value) => codec.encode(value);
        ArchiveCodec.decode(raw) => codec.decode(raw);
        ArchiveCodec.fingerprint(raw) => codec.fingerprint(raw);
        TransferDisplay.progress(id, copied, total) => display.progress(id, copied, total);
        TransferDisplay.preview(value) => display.preview(value);
        TransferDisplay.exported(path) => display.exported(path);
    };
}
public flow operations() -> ![TransferOperations => Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] ![Memory] {
    let history = NativeHistory {}; let attempts = NativeAttempts {};
    return handler {
        TransferOperations.save(session, path) => handle service.save(history, attempts, history, session, path) with bindings();
        TransferOperations.load(workspace, path) => handle service.load(history, workspace, path) with bindings();
        TransferOperations.resume_import(workspace, id) => handle service.resume_import(history, history, workspace, id) with bindings();
        TransferOperations.fork(id, through) => handle service.fork(history, history, id, through) with bindings();
        TransferOperations.resume_fork(workspace, id) => handle service.resume_fork(history, history, workspace, id) with bindings();
        TransferOperations.discard(workspace, id) => handle service.discard(workspace, id) with bindings();
        TransferOperations.status(id) => handle perform CopyStorage.lookup(id) with bindings();
        TransferOperations.copies(workspace) => handle perform CopyStorage.list(workspace) with bindings();
        TransferOperations.job(id) => handle service.job(id) with bindings();
    };
}
