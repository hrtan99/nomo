module nomo.application.transfer.handlers;

import nomo.application.transfer.service;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.transfer.effects.{CopyStorage, ArchiveFiles, ArchiveCodec, TransferDisplay, TransferOperations};
import nomo.application.transfer.ports.{CopyRepository, ArchiveWorkspace, ArchiveEncoding, TransferRenderer};
import nomo.application.conversation.ports.{ConversationReader, ConversationCatalog, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;

flow bindings<C ~ CopyRepository, F ~ ArchiveWorkspace, E ~ ArchiveEncoding, D ~ TransferRenderer>(copies: C, files: F, codec: E, display: D) -> ![CopyStorage, ArchiveFiles, ArchiveCodec, TransferDisplay => Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] ![] {
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
public flow operations<H ~ ConversationReader + ConversationCatalog + ResultPublication + CopyRepository, A ~ AttemptRepository, F ~ ArchiveWorkspace, E ~ ArchiveEncoding, D ~ TransferRenderer>(history: H, attempts: A, files: F, codec: E, display: D) -> ![TransferOperations => Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] ![] {
    let io = bindings(history, files, codec, display);
    return handler {
        TransferOperations.save(session, path) => handle service.save(history, attempts, history, session, path) with io;
        TransferOperations.load(workspace, path) => handle service.load(history, workspace, path) with io;
        TransferOperations.resume_import(workspace, id) => handle service.resume_import(history, history, workspace, id) with io;
        TransferOperations.fork(id, through) => handle service.fork(history, history, id, through) with io;
        TransferOperations.resume_fork(workspace, id) => handle service.resume_fork(history, history, workspace, id) with io;
        TransferOperations.discard(workspace, id) => handle service.discard(workspace, id) with io;
        TransferOperations.status(id) => handle perform CopyStorage.lookup(id) with io;
        TransferOperations.copies(workspace) => handle perform CopyStorage.list(workspace) with io;
        TransferOperations.job(id) => handle service.job(id) with io;
    };
}
