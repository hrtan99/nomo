module nomo.native.transfer;

import std.fs.{path, read_bytes_limited, atomic_replace, ReadLimitError};
import std.fs.IOError as FileError;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import std.codec.text.{utf8_decode, utf8_encode, Strict};
import std.json.{JsonValue, parse};
import std.agent.message.Message;
import nomo.core.json.encode;
import nomo.native.workspace.ProjectRoot;
import nomo.native.history.{NativeHistory, ConversationStore, Session, ChatMessage, append_historical, publish_summary};

type PortableInfo = { id: string, workspace: string, title: string, metadata: string };
type PortableArchive = { format: string, session: PortableInfo, events: Array<ChatMessage> };
type LegacyInfo = { id: string, root: string, title: string, created: f64, updated: f64,
    parent: JsonValue, compacted_through: i64, summary: string, usage: string };
type LegacyEvent = { id: i64, session: string, role: string, kind: string, name: string,
    content: string, data: JsonValue, created: f64 };
type LegacyArchive = { format: string, session: LegacyInfo, events: Array<LegacyEvent> };
type ExportPreview = { path: string, content: string };

flow json<T>(value: T) -> string {
    return match encode(value, "archive conversion failed", "archive encoding failed") {
        Ok(text) => text, Err(error) => { abort(error); }
    };
}

public flow save_archive(session: string, pathname: string) -> unit
    ![Memory, Console, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<FileError>, Error<ConsoleError>] {
    let history = NativeHistory {};
    let selected = history.load(session);
    let info = PortableInfo { id = selected.id, workspace = selected.workspace, title = selected.title, metadata = json(selected) };
    let content = json(PortableArchive { format = "nomo-native-conversation-1", session = info, events = history.messages(session, 0) });
    let location = match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => { abort("invalid conversation export path"); }
    };
    println("[EXPORT ] " + json(ExportPreview { path = pathname, content = content }));
    atomic_replace(location, utf8_encode(content));
    println("[EXPORTED] " + pathname);
}

public flow load_archive(workspace: string, pathname: string) -> Session
    ![Memory, Fs.read<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>] {
    let location = match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => { abort("invalid conversation import path"); }
    };
    let raw = match utf8_decode(read_bytes_limited(location, 536870912), Strict) {
        Ok(value) => value, Err(_) => { abort("conversation archive must be UTF-8"); }
    };
    let parsed = match parse(raw) {
        Ok(value) => value, Err(_) => { abort("conversation archive must be JSON"); }
    };
    let history = NativeHistory {};
    let native: Option<Message<PortableArchive>> = Message.new(parsed).cast<PortableArchive>();
    match native {
        Some(converted) => {
            let source = converted.body;
            if source.format != "nomo-native-conversation-1" { abort("unsupported native conversation format"); }
            let selected = history.create(workspace, source.session.title);
            append_historical(selected.id, "archive", "imported_source", raw);
            var summary = "";
            for item in source.events limit Iterations(2147483647) {
                append_historical(selected.id, item.role, item.name, item.text);
                if item.role == "summary" { summary = item.text; }
            }
            if summary != "" { publish_summary(selected.id, summary, -1); }
            return history.load(selected.id);
        }
        None() => {}
    }
    let legacy: Option<Message<LegacyArchive>> = Message.new(parsed).cast<LegacyArchive>();
    let source = match legacy {
        Some(converted) => converted.body,
        None() => { abort("unsupported conversation archive shape"); }
    };
    if source.format != "nomo-conversation-1" { abort("unsupported conversation format"); }
    let selected = history.create(workspace, source.session.title);
    append_historical(selected.id, "archive", "imported_source", raw);
    for item in source.events limit Iterations(2147483647) {
        append_historical(selected.id, item.role, item.name, item.content);
    }
    if source.session.summary != "" { publish_summary(selected.id, source.session.summary, -1); }
    return history.load(selected.id);
}
