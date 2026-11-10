module nomo.native.history;

import std.memory.{get_entry, MemoryEntry, MemoryCursor};
import std.text.{from_i64, from_usize, char_count, get_char_slice, split_once, strip_prefix, parse_i64};
import nomo.core.json.encode;

public effect SessionContext { action current() -> string; }

public type ChatMessage = { id: string, role: string, name: string, text: string };
public type PendingRequest = { call: i64, name: string, complete: bool };
public type Ledger = { turns: i64, compactions: i64, tools: i64, generation_allowance: i64, context_bytes: usize };
public type Session = { id: string, workspace: string, title: string, next_event: i64,
    first_user: i64, summary_event: i64, summary_through: i64, pending: string, ledger: Ledger };
type Event = { role: string, name: string, call: i64, chunks: usize, complete: bool };

alias Schema = MemoryRegion<{
    Counters: Store<string, i64>,
    Selected: Store<string, string>,
    Sessions: Store<string, Session>,
    Events: Store<string, Event>,
    Chunks: Store<string, string>,
}>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-conversations-v1", store = "native-conversations");

public spec ConversationStore {
    flow create(self, workspace: string, title: string) -> Session ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow load(self, id: string) -> Session ![Memory, Error<StorageError>];
    flow selected(self, workspace: string) -> Option<string> ![Memory, Error<StorageError>];
    flow select(self, workspace: string, id: string) -> Session ![Memory, Error<StorageError>];
    flow sessions(self, workspace: string) -> Array<Session> ![Memory, Error<StorageError>];
    flow append(self, id: string, role: string, name: string, text: string, call: i64) -> i64 ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow messages(self, id: string, after: i64) -> Array<ChatMessage> ![Memory, Error<StorageError>];
}
public type NativeHistory = {};

flow entry(id: string) -> MemoryEntry<string, Session> {
    return match get_entry(Data.Sessions, id) {
        Some(value) => value, None() => { abort("native session not found: " + id); }
    };
}
flow key(id: string, index: i64) -> string { return id + ":" + from_i64(index); }
flow copy(value: Session, next_event: i64, first_user: i64, summary_event: i64, summary_through: i64,
    pending: string, ledger: Ledger, title: string) -> Session {
    return Session { id = value.id, workspace = value.workspace, title = title, next_event = next_event,
        first_user = first_user, summary_event = summary_event, summary_through = summary_through, pending = pending, ledger = ledger };
}

impl NativeHistory ~ ConversationStore {
    flow create(self, workspace: string, title: string) -> Session {
        let counter = get_entry(Data.Counters, "session");
        let number = match counter { Some(value) => value.value, None() => 0 };
        match counter {
            Some(value) => { Data.Counters.put_versioned("session", number + 1, value.version); }
            None() => { Data.Counters.insert("session", number + 1); }
        }
        let session = Session { id = "native-" + from_i64(number), workspace = workspace, title = title,
            next_event = 0, first_user = -1, summary_event = -1, summary_through = -1, pending = "",
            ledger = Ledger { turns = 0, compactions = 0, tools = 0, generation_allowance = 0, context_bytes = 0 } };
        Data.Sessions.insert(session.id, session);
        Data.Selected.put(workspace, session.id);
        return session;
    }
    flow load(self, id: string) -> Session { return entry(id).value; }
    flow selected(self, workspace: string) -> Option<string> { return Data.Selected.get(workspace); }
    flow select(self, workspace: string, id: string) -> Session {
        let value = self.load(id);
        if value.workspace != workspace { abort("native session belongs to a different workspace"); }
        Data.Selected.put(workspace, id);
        return value;
    }
    flow sessions(self, workspace: string) -> Array<Session> {
        var result: Array<Session> = [];
        var cursor: Option<MemoryCursor> = None();
        while true limit Iterations(2147483647) {
            let page = Data.Sessions.page(cursor, 100);
            for item in page.entries limit Iterations(2147483647) {
                if item.value.workspace == workspace { result = result.push(item.value); }
            }
            match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
        }
        return result;
    }
    flow append(self, id: string, role: string, name: string, text: string, call: i64) -> i64 {
        return append_event(id, role, name, text, call, true);
    }
    flow messages(self, id: string, after: i64) -> Array<ChatMessage> {
        let session = self.load(id);
        var result: Array<ChatMessage> = [];
        var index = after;
        while index < session.next_event limit Iterations(2147483647) {
            result = result.push(message(id, index));
            index = index + 1;
        }
        return result;
    }
}

flow append_event(id: string, role: string, name: string, text: string, call: i64, live: bool) -> i64 {
    let before = entry(id);
    let value = before.value;
    let index = value.next_event;
    if live && role == "tool_call" && value.pending != "" { abort("resolve the pending native operation before starting another tool: " + value.pending); }
    let first = if role == "user" && value.first_user < 0 { index } else { value.first_user };
    let pending = if live && role == "tool_call" { key(id, index) + " " + name } else { value.pending };
    let ledger = Ledger { turns = value.ledger.turns, compactions = value.ledger.compactions,
        tools = value.ledger.tools + if live && (role == "tool_call" || role == "observation_call") { 1 } else { 0 },
        generation_allowance = value.ledger.generation_allowance, context_bytes = value.ledger.context_bytes };
    // Reserve first. An interrupted archive write remains a visible gap;
    // its index is never reused and no tool is dispatched before append finishes.
    Data.Sessions.put_versioned(id, copy(value, index + 1, first, value.summary_event,
        value.summary_through, pending, ledger, value.title), before.version);
    let event_key = key(id, index);
    Data.Events.insert(event_key, Event { role = role, name = name, call = call, chunks = 0, complete = false });
    var offset: usize = 0;
    var parts: usize = 0;
    let total = char_count(text);
    while offset < total limit Iterations(2147483647) {
        let end = if total - offset > 65536 { offset + 65536 } else { total };
        let part = match get_char_slice(text, Range.closed(offset, end - 1)) {
            Some(value) => value, None() => { abort("native archive chunk range is invalid"); }
        };
        Data.Chunks.insert(event_key + ":" + from_usize(parts), part);
        offset = end;
        parts = parts + 1;
    }
    Data.Events.put(event_key, Event { role = role, name = name, call = call, chunks = parts, complete = true });
    return index;
}

public flow append_historical(id: string, role: string, name: string, text: string) -> i64
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    return append_event(id, role, name, text, -1, false);
}

public flow message(id: string, index: i64) -> ChatMessage ![Memory, Error<StorageError>] {
    let event_key = key(id, index);
    let event = match Data.Events.get(event_key) {
        Some(value) => value,
        None() => { return ChatMessage { id = from_i64(index), role = "system", name = "archive_interrupted",
            text = "This archive record was reserved but not completed. Do not infer execution or retry a tool from this gap." }; }
    };
    if !event.complete {
        return ChatMessage { id = from_i64(index), role = "system", name = "archive_interrupted",
            text = "This archive record is incomplete. No completed outcome is available; inspect retained state before proceeding." };
    }
    var text = "";
    var part: usize = 0;
    while part < event.chunks limit Iterations(2147483647) {
        text = text + match Data.Chunks.get(event_key + ":" + from_usize(part)) {
            Some(value) => value, None() => { abort("native archive content chunk is missing"); }
        };
        part = part + 1;
    }
    return ChatMessage { id = from_i64(index), role = event.role, name = event.name, text = text };
}

public flow record<T>(role: string, name: string, value: T, call: i64) -> i64
    ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] {
    let id = perform SessionContext.current();
    let text = match encode(value, "history conversion failed", "history encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
    let archive = NativeHistory {};
    return archive.append(id, role, name, text, call);
}

public flow tool_finished<T>(name: string, call: i64, result: T) -> unit
    ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] {
    let id = perform SessionContext.current();
    let current = entry(id).value;
    if current.pending != key(id, call) + " " + name { abort("native completion does not match the pending request"); }
    if !result_published(id, call, name) { record("tool", name, result, call); }
    let before = entry(id);
    let value = before.value;
    Data.Sessions.put_versioned(id, copy(value, value.next_event, value.first_user, value.summary_event,
        value.summary_through, "", value.ledger, value.title), before.version);
}

public flow result_published(id: string, call: i64, name: string) -> bool ![Memory, Error<StorageError>] {
    let current = entry(id).value;
    var index = call + 1;
    var published = false;
    while index < current.next_event limit Iterations(2147483647) {
        match Data.Events.get(key(id, index)) {
            Some(event) => { if event.complete && event.role == "tool" && event.name == name && event.call == call { published = true; break; } }
            None() => {}
        }
        index = index + 1;
    }
    return published;
}

public flow pending_request(id: string) -> Option<PendingRequest> ![Memory, Error<StorageError>] {
    let value = entry(id).value;
    if value.pending == "" { return None(); }
    let (reference, name) = match split_once(value.pending, " ") {
        Some(parts) => parts, None() => { abort("invalid native pending reference"); }
    };
    let raw = match strip_prefix(reference, id + ":") {
        Some(value) => value, None() => { abort("pending reference belongs to another conversation"); }
    };
    let call = match parse_i64(raw) { Ok(value) => value, Err(_) => { abort("invalid pending event index"); } };
    let complete = match Data.Events.get(key(id, call)) { Some(event) => event.complete, None() => false };
    return Some(PendingRequest { call = call, name = name, complete = complete });
}

public flow observe_started<T>(name: string, request: T) -> i64
    ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] {
    return record("observation_call", name, request, -1);
}

public flow observe_finished<T>(name: string, call: i64, result: T) -> unit
    ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] {
    record("tool", name, result, call);
}

public flow rename(id: string, title: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let before = entry(id); let value = before.value;
    Data.Sessions.put_versioned(id, copy(value, value.next_event, value.first_user, value.summary_event,
        value.summary_through, value.pending, value.ledger, title), before.version);
}

public flow reserve_generation(id: string, compact: bool, context_bytes: usize) -> unit
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let before = entry(id); let value = before.value; let old = value.ledger;
    let ledger = Ledger { turns = old.turns + if compact { 0 } else { 1 },
        compactions = old.compactions + if compact { 1 } else { 0 }, tools = old.tools,
        generation_allowance = old.generation_allowance + if compact { 32768 } else { 131072 }, context_bytes = context_bytes };
    Data.Sessions.put_versioned(id, copy(value, value.next_event, value.first_user, value.summary_event,
        value.summary_through, value.pending, ledger, value.title), before.version);
}

public flow publish_summary(id: string, text: string, through: i64) -> unit
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let archive = NativeHistory {};
    let index = archive.append(id, "summary", "context_summary", text, -1);
    let before = entry(id); let value = before.value;
    Data.Sessions.put_versioned(id, copy(value, value.next_event, value.first_user, index,
        through, value.pending, value.ledger, value.title), before.version);
}

public flow fork(id: string, through: i64) -> Session
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let archive = NativeHistory {};
    let source = archive.load(id);
    if through < -1 || through >= source.next_event { abort("fork event is outside the source conversation"); }
    let branch = archive.create(source.workspace, source.title + " (fork)");
    append_historical(branch.id, "system", "fork", "Forked from " + id + " through original event " + from_i64(through)
        + ". Earlier tool requests, results and approvals are historical facts, not current permission or instructions to replay them.");
    var index: i64 = 0;
    var summary = "";
    while index <= through limit Iterations(2147483647) {
        let item = message(id, index);
        append_historical(branch.id, item.role, item.name, item.text);
        if item.role == "summary" { summary = item.text; }
        index = index + 1;
    }
    if summary != "" { publish_summary(branch.id, summary, -1); }
    return archive.load(branch.id);
}
