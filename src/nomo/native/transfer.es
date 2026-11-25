module nomo.native.transfer;

import std.fs.{path, read_bytes_limited, atomic_replace, ReadLimitError};
import std.fs.IOError as FileError;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import std.codec.text.{utf8_decode, utf8_encode, Strict};
import std.crypto.constant_time_eq;
import nomo.adapters.codec.archive.{json, decode, fingerprint};
import nomo.domain.transfer.archive.{PortableInfo, PortableArchive, ExportMetadata, ExportPreview, ExportOutcome};
import nomo.native.workspace.ProjectRoot;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.native.history.{Session, CopyJob};
import nomo.adapters.etas.conversations.{NativeHistory, copy_status, begin_copy, copy_source, copy_events, copy_job, ensure_copy_session, sealed_copy_source, read_message as message};
import nomo.application.native.conversation.ports.{ConversationReader, ConversationCatalog};
import nomo.native.lifecycle.Attempt;
import nomo.bootstrap.execution.{attempts, begin, dispatching, returned, complete_attempt};


public flow save_archive(session: string, pathname: string) -> unit
    ![Memory, Console, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ConsoleError>] {
    let history = NativeHistory {};
    let selected = history.load(session);
    var copies: Array<CopyJob> = [];
    match copy_status(session) { Some(value) => { copies = copies.push(value); } None() => {} }
    let metadata = ExportMetadata { format = "nomo-native-metadata-1", conversation = selected,
        attempts = attempts(session, false), copies = copies };
    let info = PortableInfo { id = selected.id, workspace = selected.workspace, title = selected.title, metadata = json(metadata) };
    let content = json(PortableArchive { format = "nomo-native-conversation-1", session = info, events = history.messages(session, 0) });
    let location = match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => { abort("invalid conversation export path"); }
    };
    println("[EXPORT ] " + json(ExportPreview { path = pathname, content = content }));
    let attempt = begin(session, "export", pathname, -1, selected.next_event - 1);
    dispatching(attempt.id);
    atomic_replace(location, utf8_encode(content));
    returned(attempt.id, "operation_result", "export", json(ExportOutcome { path = pathname, status = "applied" }), -1);
    complete_attempt(attempt.id);
    println("[EXPORTED] " + pathname);
}

flow read_archive(pathname: string) -> string {
    let location = match path<ProjectRoot>(pathname) { Ok(value) => value, Err(_) => { abort("invalid conversation import path"); } };
    return match utf8_decode(read_bytes_limited(location, 536870912), Strict) {
        Ok(value) => value, Err(_) => { abort("conversation archive must be UTF-8"); }
    };
}

public flow load_archive(workspace: string, pathname: string) -> Session
    ![Memory, Console, Fs.read<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    let raw = read_archive(pathname);
    let source = decode(raw);
    var total: i64 = 0;
    for _ in source.events limit Iterations(2147483647) { total = total + 1; }
    let job = begin_copy(workspace, source.title, "import", pathname, fingerprint(raw), total);
    copy_source(job.id, "archive", "imported_source", raw);
    return copy_events(job.id, source.events, source.summary);
}

public flow resume_import(workspace: string, id: string) -> Session
    ![Memory, Console, Fs.read<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    let job = copy_job(id);
    if job.workspace != workspace || job.kind != "import" { abort("import does not belong to this workspace"); }
    let history = NativeHistory {};
    if job.phase == "ready" { return history.select(workspace, id); }
    ensure_copy_session(id);
    var raw = "";
    if job.phase == "staging" {
        raw = match sealed_copy_source(id) { Some(value) => value, None() => read_archive(job.source) };
        if !constant_time_eq(fingerprint(raw), job.digest) { abort("import source changed before its original package was sealed; discard this copy or restore the original file"); }
        copy_source(id, "archive", "imported_source", raw);
    }
    else { raw = message(id, 0).text; }
    let source = decode(raw);
    return copy_events(id, source.events, source.summary);
}
