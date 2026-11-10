module nomo.native.history;

import std.memory.{get_entry, MemoryEntry, MemoryCursor};
import std.text.{from_i64, from_usize, char_count, get_char_slice, split_once, strip_prefix, parse_i64};
import nomo.core.json.encode;
import std.codec.text.utf8_encode;
import std.io.{println, IOError as ConsoleError};

public effect SessionContext { action current() -> string; }

public type ChatMessage = { id: string, role: string, name: string, text: string };
public type PendingRequest = { call: i64, name: string, complete: bool };
public type CopyJob = { id: string, workspace: string, title: string, kind: string, source: string,
    digest: bytes, total: i64, cursor: i64, phase: string };
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
alias CopySchema = MemoryRegion<{ Jobs: Store<string, CopyJob> }>;
let Copies = std.memory.region<CopySchema>(stable_id = "nomo-native-conversation-copies-v1", store = "native-conversation-copies");

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

flow allocate() -> string {
    let counter = get_entry(Data.Counters, "session");
    let number = match counter { Some(value) => value.value, None() => 0 };
    match counter {
        Some(value) => { Data.Counters.put_versioned("session", number + 1, value.version); }
        None() => { Data.Counters.insert("session", number + 1); }
    }
    return "native-" + from_i64(number);
}

flow empty_session(id: string, workspace: string, title: string) -> Session {
    return Session { id = id, workspace = workspace, title = title,
        next_event = 0, first_user = -1, summary_event = -1, summary_through = -1, pending = "",
        ledger = Ledger { turns = 0, compactions = 0, tools = 0, generation_allowance = 0, context_bytes = 0 } };
}

impl NativeHistory ~ ConversationStore {
    flow create(self, workspace: string, title: string) -> Session {
        let session = empty_session(allocate(), workspace, title);
        Data.Sessions.insert(session.id, session);
        Data.Selected.put(workspace, session.id);
        return session;
    }
    flow load(self, id: string) -> Session { return entry(id).value; }
    flow selected(self, workspace: string) -> Option<string> { return Data.Selected.get(workspace); }
    flow select(self, workspace: string, id: string) -> Session {
        let value = self.load(id);
        if value.workspace != workspace { abort("native session belongs to a different workspace"); }
        match copy_status(id) {
            Some(job) => { if job.phase != "ready" { abort("conversation copy is " + job.phase + "; use /resume-copy or /discard-copy"); } }
            None() => {}
        }
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

flow reserve_event(id: string, role: string, name: string, call: i64, live: bool) -> i64 {
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
    return index;
}

flow write_event(id: string, index: i64, role: string, name: string, text: string, call: i64) -> unit {
    let event_key = key(id, index);
    Data.Events.put(event_key, Event { role = role, name = name, call = call, chunks = 0, complete = false });
    var offset: usize = 0;
    var parts: usize = 0;
    let total = char_count(text);
    while offset < total limit Iterations(2147483647) {
        let end = if total - offset > 65536 { offset + 65536 } else { total };
        let part = match get_char_slice(text, Range.closed(offset, end - 1)) {
            Some(value) => value, None() => { abort("native archive chunk range is invalid"); }
        };
        Data.Chunks.put(event_key + ":" + from_usize(parts), part);
        offset = end;
        parts = parts + 1;
    }
    Data.Events.put(event_key, Event { role = role, name = name, call = call, chunks = parts, complete = true });
}

flow append_event(id: string, role: string, name: string, text: string, call: i64, live: bool) -> i64 {
    let index = reserve_event(id, role, name, call, live);
    write_event(id, index, role, name, text, call);
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

public flow copy_status(id: string) -> Option<CopyJob> ![Memory, Error<StorageError>] {
    return Copies.Jobs.get(id);
}

public flow copy_job(id: string) -> CopyJob ![Memory, Error<StorageError>] {
    return match copy_status(id) { Some(value) => value, None() => { abort("conversation copy not found"); } };
}

public flow copy_jobs(workspace: string) -> Array<CopyJob> ![Memory, Error<StorageError>] {
    var jobs: Array<CopyJob> = [];
    var cursor: Option<MemoryCursor> = None();
    while true limit Iterations(2147483647) {
        let page = Copies.Jobs.page(cursor, 100);
        for item in page.entries limit Iterations(2147483647) {
            if item.value.workspace == workspace { jobs = jobs.push(item.value); }
        }
        match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
    }
    return jobs;
}

flow advance_copy(id: string, cursor: i64, phase: string) -> CopyJob {
    let before = match get_entry(Copies.Jobs, id) { Some(value) => value, None() => { abort("conversation copy missing"); } };
    let old = before.value;
    let job = CopyJob { id = old.id, workspace = old.workspace, title = old.title, kind = old.kind,
        source = old.source, digest = old.digest, total = old.total, cursor = cursor, phase = phase };
    Copies.Jobs.put_versioned(id, job, before.version);
    return job;
}

public flow ensure_copy_session(id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let job = copy_job(id);
    if job.phase == "discarded" { abort("conversation copy was discarded; retained content is historical only"); }
    match Data.Sessions.get(id) {
        Some(_) => {}
        None() => { Data.Sessions.insert(id, empty_session(id, job.workspace, job.title)); }
    }
}

public flow begin_copy(workspace: string, title: string, kind: string, source: string, digest: bytes, total: i64) -> CopyJob
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let job = CopyJob { id = allocate(), workspace = workspace, title = title, kind = kind,
        source = source, digest = digest, total = total, cursor = 0, phase = "staging" };
    // The durable job precedes its session. Neither creation selects the copy.
    Copies.Jobs.insert(job.id, job);
    ensure_copy_session(job.id);
    return job;
}

flow copy_event(id: string, index: i64, role: string, name: string, text: string) -> unit {
    let current = entry(id).value;
    if index == current.next_event { reserve_event(id, role, name, -1, false); }
    else if index > current.next_event { abort("conversation copy has a noncontiguous target index"); }
    match Data.Events.get(key(id, index)) {
        Some(event) => { if event.complete { return; } }
        None() => {}
    }
    // Only an unfinished copy uses deterministic slot repair. Ordinary live
    // events keep their reserved gaps; they are never replayed by this path.
    write_event(id, index, role, name, text, -1);
}

public flow copy_source(id: string, role: string, name: string, text: string) -> unit
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let job = copy_job(id);
    if job.phase != "staging" { abort("conversation copy source is already sealed"); }
    ensure_copy_session(id);
    copy_event(id, 0, role, name, text);
    advance_copy(id, 0, "copying");
}

public flow sealed_copy_source(id: string) -> Option<string> ![Memory, Error<StorageError>] {
    match Data.Events.get(key(id, 0)) {
        Some(event) => { if event.complete { return Some(message(id, 0).text); } }
        None() => {}
    }
    return None();
}

public flow copy_events(id: string, events: Array<ChatMessage>, summary: string) -> Session
    ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
    let job = copy_job(id);
    let archive = NativeHistory {};
    if job.phase == "ready" { return archive.select(job.workspace, id); }
    if job.phase != "copying" { abort("conversation copy source is not sealed"); }
    var index: i64 = 0;
    for item in events limit Iterations(2147483647) {
        if index >= job.cursor {
            copy_event(id, index + 1, item.role, item.name, item.text);
            advance_copy(id, index + 1, "copying");
            if index == job.cursor || index + 1 == job.total || (index + 1) % 100 == 0 {
                println("[COPY   ] " + id + " " + from_i64(index + 1) + "/" + from_i64(job.total));
            }
        }
        index = index + 1;
    }
    if index != job.total { abort("conversation copy source length changed"); }
    if summary != "" {
        let slot = job.total + 1;
        copy_event(id, slot, "summary", "context_summary", summary);
        let before = entry(id); let value = before.value;
        Data.Sessions.put_versioned(id, copy(value, value.next_event, value.first_user, slot,
            -1, value.pending, value.ledger, value.title), before.version);
    }
    advance_copy(id, job.total, "ready");
    return archive.select(job.workspace, id);
}

public flow discard_copy(workspace: string, id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let job = copy_job(id);
    if job.workspace != workspace { abort("conversation copy belongs to another workspace"); }
    if job.phase == "ready" { abort("completed conversations are retained; this command discards unfinished copies only"); }
    advance_copy(id, job.cursor, "discarded");
}

public flow resume_fork(workspace: string, id: string) -> Session
    ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
    let job = copy_job(id);
    if job.workspace != workspace || job.kind != "fork" { abort("fork does not belong to this workspace"); }
    let archive = NativeHistory {};
    if job.phase == "ready" { return archive.select(workspace, id); }
    ensure_copy_session(id);
    if job.phase == "staging" {
        copy_source(id, "system", "fork", "Forked from " + job.source + " through original event " + from_i64(job.total - 1)
            + ". Earlier tool requests, results and approvals are historical facts, not current permission or instructions to replay them.");
    }
    var events: Array<ChatMessage> = [];
    var index: i64 = 0;
    var summary = "";
    while index < job.total limit Iterations(2147483647) {
        let source = match Data.Events.get(key(job.source, index)) { Some(value) => value, None() => { abort("fork source record is incomplete"); } };
        if !source.complete { abort("fork source record is incomplete"); }
        let item = message(job.source, index);
        events = events.push(item);
        if item.role == "summary" { summary = item.text; }
        index = index + 1;
    }
    return copy_events(id, events, summary);
}

public flow fork(id: string, through: i64) -> Session
    ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
    let archive = NativeHistory {};
    let source = archive.load(id);
    if through < -1 || through >= source.next_event { abort("fork event is outside the source conversation"); }
    let job = begin_copy(source.workspace, source.title + " (fork)", "fork", id, utf8_encode(""), through + 1);
    return resume_fork(source.workspace, job.id);
}
