module nomo.native.transfer;

import std.fs.{path, read_bytes_limited, atomic_replace, ReadLimitError};
import std.fs.IOError as FileError;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import std.codec.text.{utf8_decode, utf8_encode, Strict};
import std.json.{JsonValue, parse};
import std.agent.message.Message;
import std.crypto.{sha256, constant_time_eq};
import nomo.core.json.encode;
import nomo.native.workspace.ProjectRoot;
import nomo.native.history.{NativeHistory, ConversationStore, Session, ChatMessage, CopyJob, copy_status, begin_copy, copy_source, copy_events, copy_job, ensure_copy_session, sealed_copy_source, message};
import nomo.native.lifecycle.{Attempt, attempts, begin, dispatching, returned, complete_attempt};

type PortableInfo = { id: string, workspace: string, title: string, metadata: string };
type PortableArchive = { format: string, session: PortableInfo, events: Array<ChatMessage> };
type LegacyInfo = { id: string, root: string, title: string, created: f64, updated: f64,
    parent: JsonValue, compacted_through: i64, summary: string, usage: string };
type LegacyEvent = { id: i64, session: string, role: string, kind: string, name: string,
    content: string, data: JsonValue, created: f64 };
type LegacyArchive = { format: string, session: LegacyInfo, events: Array<LegacyEvent> };
type ExportPreview = { path: string, content: string };
type ExportOutcome = { path: string, status: string };
type ExportMetadata = { format: string, conversation: Session, attempts: Array<Attempt>, copies: Array<CopyJob> };

flow json<T>(value: T) -> string {
    return match encode(value, "archive conversion failed", "archive encoding failed") {
        Ok(text) => text, Err(error) => { abort(error); }
    };
}

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

type Imported = { title: string, events: Array<ChatMessage>, summary: string };

flow decode(raw: string) -> Imported {
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => { abort("conversation archive must be JSON"); } };
    let native: Option<Message<PortableArchive>> = Message.new(parsed).cast<PortableArchive>();
    match native {
        Some(converted) => {
            let source = converted.body;
            if source.format != "nomo-native-conversation-1" { abort("unsupported native conversation format"); }
            var summary = "";
            for item in source.events limit Iterations(2147483647) { if item.role == "summary" { summary = item.text; } }
            return Imported { title = source.session.title, events = source.events, summary = summary };
        }
        None() => {}
    }
    let legacy: Option<Message<LegacyArchive>> = Message.new(parsed).cast<LegacyArchive>();
    let source = match legacy { Some(value) => value.body, None() => { abort("unsupported conversation archive shape"); } };
    if source.format != "nomo-conversation-1" { abort("unsupported conversation format"); }
    var events: Array<ChatMessage> = [];
    for item in source.events limit Iterations(2147483647) {
        events = events.push(ChatMessage { id = "", role = item.role, name = item.name, text = item.content });
    }
    return Imported { title = source.session.title, events = events, summary = source.session.summary };
}

flow fingerprint(raw: string) -> bytes {
    let converted: Option<Message<bytes>> = Message.new(sha256(utf8_encode(raw))).cast<bytes>();
    return match converted { Some(value) => value.body, None() => { abort("native SHA-256 representation unavailable"); } };
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
