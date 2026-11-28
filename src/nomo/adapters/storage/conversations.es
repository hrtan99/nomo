module nomo.adapters.storage.conversations;

import nomo.application.conversation.ports.{
    ConversationCatalog,
    ConversationReader,
    ConversationWriter,
    GenerationReservation,
    ResultPublication
};
import nomo.application.editing.ports.MutationHistoryStore;
import nomo.application.scope.SessionContext;
import nomo.application.transfer.ports.CopyRepository;
import nomo.domain.conversation.{ChatMessage, PendingRequest};
import nomo.domain.wire.encode;
import nomo.native.history.{CopyJob, Event, Ledger, Session};
import std.json.JsonValue;
import std.memory.{MemoryCursor, MemoryEntry};
import std.text.{TextBuilder, char_count, from_i64, from_usize, get_char_slice, parse_i64, split_once, strip_prefix};

alias Schema = MemoryRegion<
    {
        Counters: Store<string, i64>,
        Selected: Store<string, string>,
        Sessions: Store<string, Session>,
        Events: Store<string, Event>,
        Chunks: Store<string, string>,
    }
>;

public let Data = std.memory.region<Schema>(
    stable_id = "nomo-native-conversations-v1",
    store = "native-conversations"
);

alias CopySchema = MemoryRegion<{
    Jobs: Store<string, CopyJob>
}>;

public let Copies = std.memory.region<CopySchema>(
    stable_id = "nomo-native-conversation-copies-v1",
    store = "native-conversation-copies"
);

public type NativeHistory = {};

impl NativeHistory ~ GenerationReservation {
    flow reserve(self, id: string, compact: bool, context_bytes: usize) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ] {
        reserve_generation(id, compact, context_bytes);
    }
}

impl NativeHistory ~ ResultPublication {
    flow prepare_result(self, id: string, role: string, name: string, call: i64) -> i64 ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ] {
        return reserve_result(id, role, name, call);
    }

    flow publish_result(self, id: string, index: i64, text: string) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ] {
        complete_result(id, index, text);
    }

    flow result_complete(self, id: string, index: i64) -> bool {
        return complete_event(id, index);
    }

    flow select_summary(self, id: string, index: i64, through: i64) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ] {
        adopt_summary(id, index, through);
    }

    flow finish_command(self, id: string, call: i64) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ] {
        handle tool_finished("command", call, "recorded result retained")
        with {
            SessionContext.current() => id;
        };
    }

    flow acknowledge(self, id: string, call: i64, note: string) -> i64 ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ] {
        return acknowledge_command(id, call, note);
    }
}

flow entry(id: string) -> MemoryEntry<string, Session> {
    return match Data.Sessions.get_entry(id) {
        Some(value) => value,
        None() => abort("native session not found: " + id),
    };
}

flow key(id: string, index: i64) -> string {
    return id + ":" + from_i64(index);
}

flow allocate() -> string {
    let counter = Data.Counters.get_entry("session");
    let number = match counter {
        Some(value) => value.value,
        None() => 0
    };
    match counter {
        Some(value) => {
            Data.Counters.put_versioned("session", number + 1, value.version);
        }
        None() => {
            Data.Counters.insert("session", number + 1);
        }
    }
    return "native-" + from_i64(number);
}

flow empty_session(id: string, workspace: string, title: string) -> Session {
    return Session {
        id,
        workspace,
        title,
        next_event = 0,
        first_user = -1,
        summary_event = -1,
        summary_through = -1,
        pending = "",
        ledger = Ledger {
            turns = 0,
            compactions = 0,
            tools = 0,
            generation_allowance = 0,
            context_bytes = 0
        }
    };
}

impl NativeHistory ~ ConversationReader {
    flow load(self, id: string) -> Session {
        return entry(id).value;
    }

    flow messages(self, id: string, after: i64) -> Array<ChatMessage> {
        let session = self.load(id);
        var result: Array<ChatMessage> = [];
        var index = after;
        @limits([Iterations(2147483647)]) while index < session.next_event {
            result = result.push(read_message(id, index));
            index = index + 1;
        }
        return result;
    }

    flow message(self, id: string, index: i64) -> ChatMessage {
        return read_message(id, index);
    }
}

impl NativeHistory ~ ConversationWriter {
    flow append(self, id: string, role: string, name: string, text: string, call: i64) -> i64 ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ] {
        return append_event(id, role, name, text, call, true);
    }
}

impl NativeHistory ~ ConversationCatalog {
    flow rename(self, id: string, title: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        rename(id, title);
    }

    flow create(self, workspace: string, title: string) -> Session ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ] {
        let session = empty_session(allocate(), workspace, title);
        Data.Sessions.insert(session.id, session);
        Data.Selected.put(workspace, session.id);
        return session;
    }

    flow selected(self, workspace: string) -> Option<string> {
        return Data.Selected.get(workspace);
    }

    flow select(self, workspace: string, id: string) -> Session ![Memory, Error<StorageError>] {
        let value = self.load(id);
        if value.workspace != workspace {
            abort("native session belongs to a different workspace");
        }
        match copy_status(id) {
            Some(job) => {
                if job.phase != "ready" {
                    abort("conversation copy is " + job.phase + "; use /resume-copy or /discard-copy");
                }
            },
            None() => (),
        }
        Data.Selected.put(workspace, id);
        return value;
    }

    flow sessions(self, workspace: string) -> Array<Session> {
        return stored_sessions(Some(workspace));
    }

    flow all_sessions(self) -> Array<Session> {
        return stored_sessions(None());
    }
}

flow stored_sessions(workspace: Option<string>) -> Array<Session> {
    var result: Array<Session> = [];
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = Data.Sessions.page(cursor, 100);
        result = result.extend(
            page.entries.iter().filter(
                item =>
                match workspace {
                    Some(path) => item.value.workspace == path,
                    None() => true
                }
            ).map(item => item.value).collect()
        );
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            }
            None() => {
                break;
            }
        }
    }
    return result;
}

flow reserve_event(id: string, role: string, name: string, call: i64, live: bool) -> i64 {
    let before = entry(id);
    let value = before.value;
    let index = value.next_event;
    if live && role == "tool_call" && value.pending != "" {
        abort("resolve the pending native operation before starting another tool: " + value.pending);
    }
    let first = if role == "user" && value.first_user < 0 {
        index
    } else {
        value.first_user
    };
    let pending = if live && role == "tool_call" {
        key(id, index) + " " + name
    } else {
        value.pending
    };
    let ledger = value.ledger {
        tools = value.ledger.tools + if live && (role == "tool_call" || role == "observation_call") {
            1
        } else {
            0
        }
    };
    // Reserve first. An interrupted archive write remains a visible gap;
    // its index is never reused and no tool is dispatched before append finishes.
    Data.Sessions.put_versioned(
        id,
        value {
            next_event = index + 1,
            first_user = first,
            pending,
            ledger
        },
        before.version
    );
    return index;
}

flow write_event(id: string, index: i64, role: string, name: string, text: string, call: i64) -> unit {
    let event_key = key(id, index);
    Data.Events.put(event_key, Event {
        role,
        name,
        call,
        chunks = 0,
        complete = false
    });
    var offset: usize = 0;
    var parts: usize = 0;
    let total = char_count(text);
    @limits([Iterations(2147483647)]) while offset < total {
        let end = if total - offset > 65536 {
            offset + 65536
        } else {
            total
        };
        let part = match get_char_slice(text, Range.closed(offset, end - 1)) {
            Some(value) => value,
            None() => abort("native archive chunk range is invalid"),
        };
        Data.Chunks.put(event_key + ":" + from_usize(parts), part);
        offset = end;
        parts = parts + 1;
    }
    Data.Events.put(event_key, Event {
        role,
        name,
        call,
        chunks = parts,
        complete = true
    });
}

flow append_event(id: string, role: string, name: string, text: string, call: i64, live: bool) -> i64 {
    let index = reserve_event(id, role, name, call, live);
    write_event(id, index, role, name, text, call);
    return index;
}

public flow append_historical(id: string, role: string, name: string, text: string) -> i64
![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    return append_event(id, role, name, text, -1, false);
}

public flow read_message(id: string, index: i64) -> ChatMessage ![
    Memory,
    Error<StorageError>,
    Error<BudgetExceeded>
] {
    let event_key = key(id, index);
    let event = match Data.Events.get(event_key) {
        Some(value) => value,
        None() => {
            return ChatMessage {
                id = from_i64(index),
                role = "system",
                name = "archive_interrupted",
                text = "This archive record was reserved but not completed. Do not infer execution or retry a tool from this gap."
            };
        }
    };
    if !event.complete {
        return ChatMessage {
            id = from_i64(index),
            role = "system",
            name = "archive_interrupted",
            text = "This archive record is incomplete. No completed outcome is available; inspect retained state before proceeding."
        };
    }
    var text = TextBuilder.new();
    var part: usize = 0;
    @limits([Iterations(2147483647)]) while part < event.chunks {
        text.append(
            match Data.Chunks.get(event_key + ":" + from_usize(part)) {
                Some(value) => value,
                None() => abort("native archive content chunk is missing"),
            }
        );
        part = part + 1;
    }
    return ChatMessage {
        id = from_i64(index),
        role = event.role,
        name = event.name,
        text = text.build()
    };
}

public flow reserve_result(id: string, role: string, name: string, call: i64) -> i64
![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let index = reserve_event(id, role, name, call, false);
    Data.Events.put(key(id, index), Event {
        role,
        name,
        call,
        chunks = 0,
        complete = false
    });
    return index;
}

public flow complete_result(id: string, index: i64, text: string) -> unit
![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let event = match Data.Events.get(key(id, index)) {
        Some(value) => value,
        None() => abort("reserved result not found"),
    };
    if !event.complete {
        write_event(id, index, event.role, event.name, text, event.call);
    }
}

public flow complete_event(id: string, index: i64) -> bool ![Memory, Error<StorageError>] {
    return match Data.Events.get(key(id, index)) {
        Some(value) => value.complete,
        None() => false
    };
}

public flow acknowledge_command(id: string, call: i64, note: string) -> i64
![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let archive = NativeHistory {};
    if archive.load(id).pending != key(id, call) + " command" {
        abort("command recovery does not own the pending request");
    }
    let recovery_event = archive.append(id, "recovery", "command_outcome_unknown", note, call);
    let before = entry(id);
    let value = before.value;
    Data.Sessions.put_versioned(id, value {
        pending = ""
    }, before.version);
    return recovery_event;
}

public flow record<T>(role: string, name: string, value: T, call: i64) -> i64
![SessionContext.current, Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let id = perform SessionContext.current();
    let text = match encode(value, "history conversion failed", "history encoding failed") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
    let archive = NativeHistory {};
    return archive.append(id, role, name, text, call);
}

public flow tool_finished<T>(name: string, call: i64, result: T) -> unit
![SessionContext.current, Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let id = perform SessionContext.current();
    let current = entry(id).value;
    if current.pending != key(id, call) + " " + name {
        abort("native completion does not match the pending request");
    }
    if !result_published(id, call, name) {
        record("tool", name, result, call);
    }
    let before = entry(id);
    let value = before.value;
    Data.Sessions.put_versioned(id, value {
        pending = ""
    }, before.version);
}

public flow result_published(id: string, call: i64, name: string) -> bool ![
    Memory,
    Error<StorageError>,
    Error<BudgetExceeded>
] {
    let current = entry(id).value;
    var index = call + 1;
    var published = false;
    @limits([Iterations(2147483647)]) while index < current.next_event {
        match Data.Events.get(key(id, index)) {
            Some(event) => {
                if event.complete && event.role == "tool" && event.name == name && event.call == call {
                    published = true;
                    break;
                }
            },
            None() => (),
        }
        index = index + 1;
    }
    return published;
}

public flow pending_request(id: string) -> Option<PendingRequest> ![Memory, Error<StorageError>] {
    let value = entry(id).value;
    if value.pending == "" {
        return None();
    }
    let (reference, name) = match split_once(value.pending, " ") {
        Some(parts) => parts,
        None() => abort("invalid native pending reference"),
    };
    let raw = match strip_prefix(reference, id + ":") {
        Some(value) => value,
        None() => abort("pending reference belongs to another conversation"),
    };
    let call = match parse_i64(raw) {
        Ok(value) => value,
        Err(_) => abort("invalid pending event index"),
    };
    let complete = match Data.Events.get(key(id, call)) {
        Some(event) => event.complete,
        None() => false
    };
    return Some(PendingRequest {
        call,
        name,
        complete
    });
}

public flow rename(id: string, title: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let before = entry(id);
    let value = before.value;
    Data.Sessions.put_versioned(id, value {
        title
    }, before.version);
}

public flow reserve_generation(id: string, compact: bool, context_bytes: usize) -> unit
![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let before = entry(id);
    let value = before.value;
    let old = value.ledger;
    let ledger = old {
        turns = old.turns + if compact {
            0
        } else {
            1
        },
        compactions = old.compactions + if compact {
            1
        } else {
            0
        },
        generation_allowance = old.generation_allowance + if compact {
            32768
        } else {
            131072
        },
        context_bytes
    };
    Data.Sessions.put_versioned(id, value {
        ledger
    }, before.version);
}

public flow publish_summary(id: string, text: string, through: i64) -> unit
![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let archive = NativeHistory {};
    let index = archive.append(id, "summary", "context_summary", text, -1);
    adopt_summary(id, index, through);
}

public flow adopt_summary(id: string, index: i64, through: i64) -> unit
![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let event = match Data.Events.get(key(id, index)) {
        Some(value) => value,
        None() => abort("summary record missing"),
    };
    if !event.complete || event.role != "summary" {
        abort("summary record is incomplete");
    }
    let before = entry(id);
    let value = before.value;
    Data.Sessions.put_versioned(
        id,
        value {
            summary_event = index,
            summary_through = through
        },
        before.version
    );
}

public flow copy_status(id: string) -> Option<CopyJob> ![Memory, Error<StorageError>] {
    return Copies.Jobs.get(id);
}

public flow copy_job(id: string) -> CopyJob ![Memory, Error<StorageError>] {
    return match copy_status(id) {
        Some(value) => value,
        None() => abort("conversation copy not found"),
    };
}

public flow copy_jobs(workspace: string) -> Array<CopyJob> ![
    Memory,
    Error<StorageError>,
    Error<BudgetExceeded>
] {
    var jobs: Array<CopyJob> = [];
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = Copies.Jobs.page(cursor, 100);
        jobs = jobs.extend(
            page.entries.iter()
                .filter(item => item.value.workspace == workspace)
                .map(item => item.value).collect()
        );
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            }
            None() => {
                break;
            }
        }
    }
    return jobs;
}

public flow advance_copy(id: string, cursor: i64, phase: string) -> CopyJob ![
    Memory,
    Error<StorageError>,
    Error<MemoryConflict>
] {
    let before = match Copies.Jobs.get_entry(id) {
        Some(value) => value,
        None() => abort("conversation copy missing"),
    };
    let old = before.value;
    let job = old {
        cursor,
        phase
    };
    Copies.Jobs.put_versioned(id, job, before.version);
    return job;
}

public flow ensure_copy_session(id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let job = copy_job(id);
    if job.phase == "discarded" {
        abort("conversation copy was discarded; retained content is historical only");
    }
    match Data.Sessions.get(id) {
        Some(_) => (),
        None() => {
            Data.Sessions.insert(id, empty_session(id, job.workspace, job.title));
        }
    }
}

public flow prepare_copy(
    workspace: string,
    title: string,
    kind: string,
    source: string,
    digest: bytes,
    total: i64
) -> CopyJob
![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let job = CopyJob {
        id = allocate(),
        workspace,
        title,
        kind,
        source,
        digest,
        total,
        cursor = 0,
        phase = "staging"
    };
    // The durable job precedes its session. Neither creation selects the copy.
    Copies.Jobs.insert(job.id, job);
    return job;
}

public flow copy_event(id: string, index: i64, role: string, name: string, text: string) -> unit ![
    Memory,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<BudgetExceeded>
] {
    let current = entry(id).value;
    if index == current.next_event {
        reserve_event(id, role, name, -1, false);
    }
    else if index > current.next_event {
        abort("conversation copy has a noncontiguous target index");
    }
    match Data.Events.get(key(id, index)) {
        Some(event) => {
            if event.complete {
                return;
            }
        },
        None() => (),
    }
    // Only an unfinished copy uses deterministic slot repair. Ordinary live
    // events keep their reserved gaps; they are never replayed by this path.
    write_event(id, index, role, name, text, -1);
}

public flow sealed_copy_source(id: string) -> Option<string> ![
    Memory,
    Error<StorageError>,
    Error<BudgetExceeded>
] {
    match Data.Events.get(key(id, 0)) {
        Some(event) => {
            if event.complete {
                return Some(read_message(id, 0).text);
            }
        },
        None() => (),
    }
    return None();
}

public flow copy_summary(id: string, slot: i64) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let before = entry(id);
    let value = before.value;
    Data.Sessions.put_versioned(id, value {
        summary_event = slot,
        summary_through = -1
    }, before.version);
}

public flow copy_record_complete(id: string, index: i64) -> bool ![Memory, Error<StorageError>] {
    return match Data.Events.get(key(id, index)) {
        Some(value) => value.complete,
        None() => abort("fork source record is incomplete"),
    };
}

impl NativeHistory ~ MutationHistoryStore {
    flow record(self, role: string, name: string, value: JsonValue, call: i64) -> i64 ![
        SessionContext.current,
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ] {
        return record(role, name, value, call);
    }

    flow finish(self, name: string, call: i64, value: JsonValue) -> unit ![
        SessionContext.current,
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ] {
        tool_finished(name, call, value);
    }

    flow pending(self, id: string) -> Option<PendingRequest> ![Memory, Error<StorageError>] {
        return pending_request(id);
    }

    flow published(self, id: string, call: i64, name: string) -> bool ![
        Memory,
        Error<StorageError>,
        Error<BudgetExceeded>
    ] {
        return result_published(id, call, name);
    }
}

impl NativeHistory ~ CopyRepository {
    flow lookup(self, id: string) -> Option<CopyJob> ![Memory, Error<StorageError>] {
        return copy_status(id);
    }

    flow list(self, workspace: string) -> Array<CopyJob> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        return copy_jobs(workspace);
    }

    flow prepare(
        self,
        workspace: string,
        title: string,
        kind: string,
        source: string,
        digest: bytes,
        total: i64
    ) -> CopyJob ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        return prepare_copy(workspace, title, kind, source, digest, total);
    }

    flow ensure_session(self, id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        ensure_copy_session(id);
    }

    flow advance(self, id: string, cursor: i64, phase: string) -> CopyJob ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ] {
        return advance_copy(id, cursor, phase);
    }

    flow event(self, id: string, index: i64, role: string, name: string, text: string) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ] {
        copy_event(id, index, role, name, text);
    }

    flow sealed(self, id: string) -> Option<string> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        return sealed_copy_source(id);
    }

    flow summary(self, id: string, slot: i64) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        copy_summary(id, slot);
    }

    flow complete(self, id: string, index: i64) -> bool ![Memory, Error<StorageError>] {
        return copy_record_complete(id, index);
    }
}
