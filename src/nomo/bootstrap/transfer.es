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

flow bindings() -> ![CopyStorage, ArchiveFiles, ArchiveCodec, TransferDisplay => Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] ![] {
    let copies = NativeCopies {}; let files = ProjectArchives {}; let codec = JsonArchiveEncoding {}; let display = TerminalTransfer {};
    return handler {
        CopyStorage.lookup(id) => { resume copies.lookup(id); }
        CopyStorage.list(workspace) => { resume copies.list(workspace); }
        CopyStorage.prepare(workspace, title, kind, source, digest, total) => { resume copies.prepare(workspace, title, kind, source, digest, total); }
        CopyStorage.ensure_session(id) => { copies.ensure_session(id); resume; }
        CopyStorage.advance(id, cursor, phase) => { resume copies.advance(id, cursor, phase); }
        CopyStorage.event(id, index, role, name, text) => { copies.event(id, index, role, name, text); resume; }
        CopyStorage.sealed(id) => { resume copies.sealed(id); }
        CopyStorage.summary(id, slot) => { copies.summary(id, slot); resume; }
        CopyStorage.complete(id, index) => { resume copies.complete(id, index); }
        ArchiveFiles.target(path) => { resume files.target(path); }
        ArchiveFiles.read(path) => { resume files.read(path); }
        ArchiveFiles.replace(target, text) => { files.replace(target, text); resume; }
        ArchiveCodec.encode(value) => { resume codec.encode(value); }
        ArchiveCodec.decode(raw) => { resume codec.decode(raw); }
        ArchiveCodec.fingerprint(raw) => { resume codec.fingerprint(raw); }
        TransferDisplay.progress(id, copied, total) => { display.progress(id, copied, total); resume; }
        TransferDisplay.preview(value) => { display.preview(value); resume; }
        TransferDisplay.exported(path) => { display.exported(path); resume; }
    };
}
public flow operations() -> ![TransferOperations => Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] ![Memory] {
    let history = NativeHistory {}; let attempts = NativeAttempts {};
    return handler {
        TransferOperations.save(session, path) => { handle { service.save(history, attempts, history, session, path) } with bindings(); resume; }
        TransferOperations.load(workspace, path) => { let result = handle { service.load(history, workspace, path) } with bindings(); resume result; }
        TransferOperations.resume_import(workspace, id) => { let result = handle { service.resume_import(history, history, workspace, id) } with bindings(); resume result; }
        TransferOperations.fork(id, through) => { let result = handle { service.fork(history, history, id, through) } with bindings(); resume result; }
        TransferOperations.resume_fork(workspace, id) => { let result = handle { service.resume_fork(history, history, workspace, id) } with bindings(); resume result; }
        TransferOperations.discard(workspace, id) => { handle { service.discard(workspace, id) } with bindings(); resume; }
        TransferOperations.status(id) => { let result = handle { perform CopyStorage.lookup(id) } with bindings(); resume result; }
        TransferOperations.copies(workspace) => { let result = handle { perform CopyStorage.list(workspace) } with bindings(); resume result; }
        TransferOperations.job(id) => { let result = handle { service.job(id) } with bindings(); resume result; }
    };
}
