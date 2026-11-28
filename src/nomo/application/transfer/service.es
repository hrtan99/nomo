module nomo.application.transfer.service;

import nomo.application.conversation.ports.{ConversationCatalog, ConversationReader, ResultPublication};
import nomo.application.execution.attempts.{begin, complete_attempt, dispatching, returned};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.transfer.ports.{
    ArchiveCodec,
    ArchiveEncoding,
    ArchiveFiles,
    ArchiveWorkspace,
    CopyRepository,
    CopyStorage,
    TransferDisplay,
    TransferOperations,
    TransferRenderer
};
import nomo.domain.archives.{
    ArchiveDocument,
    ExportMetadata,
    ExportOutcome,
    ExportPreview,
    PortableArchive,
    PortableInfo
};
import nomo.domain.conversation.ChatMessage;
import nomo.native.history.{CopyJob, Session};
import nomo.native.workspace.ProjectRoot;
import std.codec.text.utf8_encode;
import std.crypto.constant_time_eq;
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError};
import std.io.IOError;
import std.text.from_i64;

flow bindings<C ~ CopyRepository, F ~ ArchiveWorkspace, E ~ ArchiveEncoding, D ~ TransferRenderer>(
    copies: C,
    files: F,
    codec: E,
    display: D
) -> ![
    CopyStorage,
    ArchiveFiles,
    ArchiveCodec,
    TransferDisplay => Memory,
    Console,
    Fs.read<ProjectRoot>,
    Fs.atomic_replace<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<fs_IOError>,
    Error<ReadLimitError>,
    Error<IOError>,
    Error<BudgetExceeded>
] ![] {
    return handler {
        CopyStorage.lookup(id) => copies.lookup(id);
        CopyStorage.list(workspace) => copies.list(workspace);
        CopyStorage.prepare(workspace, title, kind, source, digest, total) => copies.prepare(
            workspace,
            title,
            kind,
            source,
            digest,
            total
        );
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

public flow operations<
    H ~ ConversationReader + ConversationCatalog + ResultPublication
        + CopyRepository,
    A ~ AttemptRepository,
    F ~ ArchiveWorkspace,
    E ~ ArchiveEncoding,
    D ~ TransferRenderer
>(history: H, attempts: A, files: F, codec: E, display: D) -> ![
    TransferOperations => Memory,
    Console,
    Fs.read<ProjectRoot>,
    Fs.atomic_replace<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<fs_IOError>,
    Error<ReadLimitError>,
    Error<IOError>,
    Error<BudgetExceeded>
] ![] {
    let io = bindings(history, files, codec, display);
    return handler {
        TransferOperations.save(session, path) => handle save(history, attempts, history, session, path) with io;
        TransferOperations.load(workspace, path) => handle load(history, workspace, path) with io;
        TransferOperations.resume_import(workspace, id) => handle resume_import(
            history,
            history,
            workspace,
            id
        ) with io;
        TransferOperations.fork(id, through) => handle fork(history, history, id, through) with io;
        TransferOperations.resume_fork(workspace, id) => handle resume_fork(history, history, workspace, id) with io;
        TransferOperations.discard(workspace, id) => handle discard(workspace, id) with io;
        TransferOperations.status(id) => handle perform CopyStorage.lookup(id) with io;
        TransferOperations.copies(workspace) => handle perform CopyStorage.list(workspace) with io;
        TransferOperations.job(id) => handle job(id) with io;
    };
}

public flow job(id: string) -> CopyJob ![CopyStorage] {
    return match perform CopyStorage.lookup(id) {
        Some(value) => value,
        None() => abort("conversation copy not found"),
    };
}

flow prepare(workspace: string, title: string, kind: string, source: string, digest: bytes, total: i64) -> CopyJob {
    let value = perform CopyStorage.prepare(workspace, title, kind, source, digest, total);
    perform CopyStorage.ensure_session(value.id);
    return value;
}

flow seal(id: string, role: string, name: string, text: string) -> unit {
    let value = job(id);
    if value.phase != "staging" {
        abort("conversation copy source is already sealed");
    }
    perform CopyStorage.ensure_session(id);
    perform CopyStorage.event(id, 0, role, name, text);
    perform CopyStorage.advance(id, 0, "copying");
}

public flow copy_events<C ~ ConversationCatalog>(
    catalog: C,
    id: string,
    events: Array<ChatMessage>,
    summary: string
) -> Session
![CopyStorage, TransferDisplay, Memory, Error<StorageError>, Error<MemoryConflict>] {
    let value = job(id);
    if value.phase == "ready" {
        return catalog.select(value.workspace, id);
    }
    if value.phase != "copying" {
        abort("conversation copy source is not sealed");
    }
    var index: i64 = 0;
    for item in events {
        if index >= value.cursor {
            perform CopyStorage.event(id, index + 1, item.role, item.name, item.text);
            perform CopyStorage.advance(id, index + 1, "copying");
            if index == value.cursor || index + 1 == value.total || (index + 1) % 100 == 0 {
                perform TransferDisplay.progress(id, index + 1, value.total);
            }
        }
        index = index + 1;
    }
    if index != value.total {
        abort("conversation copy source length changed");
    }
    if summary != "" {
        let slot = value.total + 1;
        perform CopyStorage.event(id, slot, "summary", "context_summary", summary);
        perform CopyStorage.summary(id, slot);
    }
    perform CopyStorage.advance(id, value.total, "ready");
    return catalog.select(value.workspace, id);
}

public flow discard(workspace: string, id: string) -> unit ![CopyStorage] {
    let value = job(id);
    if value.workspace != workspace {
        abort("conversation copy belongs to another workspace");
    }
    if value.phase == "ready" {
        abort("completed conversations are retained; this command discards unfinished copies only");
    }
    perform CopyStorage.advance(id, value.cursor, "discarded");
}

public flow resume_fork<R ~ ConversationReader, C ~ ConversationCatalog>(
    history: R,
    catalog: C,
    workspace: string,
    id: string
) -> Session
![CopyStorage, TransferDisplay, Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let value = job(id);
    if value.workspace != workspace || value.kind != "fork" {
        abort("fork does not belong to this workspace");
    }
    if value.phase == "ready" {
        return catalog.select(workspace, id);
    }
    perform CopyStorage.ensure_session(id);
    if value.phase == "staging" {
        seal(
            id,
            "system",
            "fork",
            "Forked from " + value.source + " through original event " + from_i64(value.total - 1)
                + ". Earlier tool requests, results and approvals are historical facts, not current permission or instructions to replay them."
        );
    }
    var events: Array<ChatMessage> = [];
    var index: i64 = 0;
    var summary = "";
    @limits([Iterations(2147483647)]) while index < value.total {
        if !perform CopyStorage.complete(value.source, index) {
            abort("fork source record is incomplete");
        }
        let item = history.message(value.source, index);
        events = events.push(item);
        if item.role == "summary" {
            summary = item.text;
        }
        index = index + 1;
    }
    return copy_events(catalog, id, events, summary);
}

public flow fork<R ~ ConversationReader, C ~ ConversationCatalog>(
    history: R,
    catalog: C,
    id: string,
    through: i64
) -> Session
![CopyStorage, TransferDisplay, Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let source = history.load(id);
    if through < -1 || through >= source.next_event {
        abort("fork event is outside the source conversation");
    }
    let value = prepare(source.workspace, source.title + " (fork)", "fork", id, utf8_encode(""), through + 1);
    return resume_fork(history, catalog, source.workspace, value.id);
}

public flow load<C ~ ConversationCatalog>(catalog: C, workspace: string, path: string) -> Session
![
    CopyStorage,
    ArchiveCodec,
    ArchiveFiles,
    TransferDisplay,
    Memory,
    Error<StorageError>,
    Error<MemoryConflict>
] {
    let raw = perform ArchiveFiles.read(path);
    let source = perform ArchiveCodec.decode(raw);
    let total: i64 = source.events.iter().fold(0, (count: i64, event: ChatMessage) => count + 1);
    let value = prepare(workspace, source.title, "import", path, perform ArchiveCodec.fingerprint(raw), total);
    seal(value.id, "archive", "imported_source", raw);
    return copy_events(catalog, value.id, source.events, source.summary);
}

public flow resume_import<R ~ ConversationReader, C ~ ConversationCatalog>(
    history: R,
    catalog: C,
    workspace: string,
    id: string
) -> Session
![
    CopyStorage,
    ArchiveCodec,
    ArchiveFiles,
    TransferDisplay,
    Memory,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<BudgetExceeded>
] {
    let value = job(id);
    if value.workspace != workspace || value.kind != "import" {
        abort("import does not belong to this workspace");
    }
    if value.phase == "ready" {
        return catalog.select(workspace, id);
    }
    perform CopyStorage.ensure_session(id);
    var raw = "";
    if value.phase == "staging" {
        raw = match perform CopyStorage.sealed(id) {
            Some(value) => value,
            None() => perform ArchiveFiles.read(value.source)
        };
        if !constant_time_eq(perform ArchiveCodec.fingerprint(raw), value.digest) {
            abort("import source changed before its original package was sealed; discard this copy or restore the original file");
        }
        seal(id, "archive", "imported_source", raw);
    }
    else {
        raw = history.message(id, 0).text;
    }
    let source = perform ArchiveCodec.decode(raw);
    return copy_events(catalog, id, source.events, source.summary);
}

public flow save<R ~ ConversationReader, A ~ AttemptRepository, P ~ ResultPublication>(
    history: R,
    attempts: A,
    publication: P,
    session: string,
    pathname: string
) -> unit
![
    CopyStorage,
    ArchiveCodec,
    ArchiveFiles,
    TransferDisplay,
    Memory,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<BudgetExceeded>
] {
    let selected = history.load(session);
    var copies: Array<CopyJob> = [];
    match perform CopyStorage.lookup(session) {
        Some(value) => {
            copies = copies.push(value);
        }
        None() => (),
    }
    let metadata = ExportMetadata {
        format = "nomo-native-metadata-1",
        conversation = selected,
        attempts = attempts.list(session, false),
        copies
    };
    let info = PortableInfo {
        id = selected.id,
        workspace = selected.workspace,
        title = selected.title,
        metadata = perform ArchiveCodec.encode(ArchiveDocument.Metadata(metadata))
    };
    let content = perform ArchiveCodec.encode(
        ArchiveDocument.Conversation(
            PortableArchive {
                format = "nomo-native-conversation-1",
                session = info,
                events = history.messages(session, 0)
            }
        )
    );
    let target = perform ArchiveFiles.target(pathname);
    perform TransferDisplay.preview(ExportPreview {
        path = pathname,
        content
    });
    let attempt = begin(attempts, session, "export", pathname, -1, selected.next_event - 1);
    dispatching(attempts, attempt.id);
    perform ArchiveFiles.replace(target, content);
    returned(
        attempts,
        publication,
        attempt.id,
        "operation_result",
        "export",
        perform ArchiveCodec.encode(
            ArchiveDocument.Outcome(ExportOutcome {
                path = pathname,
                status = "applied"
            })
        ),
        -1
    );
    complete_attempt(attempts, publication, history, attempt.id);
    perform TransferDisplay.exported(pathname);
}
