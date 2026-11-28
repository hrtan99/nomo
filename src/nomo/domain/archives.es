module nomo.domain.archives;

import nomo.domain.conversation.ChatMessage;
import nomo.domain.processes.ArchivedJob as processes_ArchivedJob;
import nomo.native.configuration.Cached;
import nomo.native.history.{CopyJob, Event as history_Event, Session as history_Session};
import nomo.native.lifecycle.Attempt as lifecycle_Attempt;
import nomo.native.mutations.{Journal as mutations_Journal, SavedPath, Step as mutations_Step};
import nomo.native.processes.{Job as processes_Job, JobEvent};
import std.json.JsonValue;

// Stored facts, including incomplete records, are copied without executing them.
public enum NativeRecord {
    Counter(string, i64),
    Selected(string, string),
    Session(string, history_Session),
    Event(string, history_Event),
    Chunk(string, string),
    Copy(string, CopyJob),
    AttemptCounter(string, i64),
    Attempt(string, lifecycle_Attempt),
    Configuration(string, Cached),
    Projects(string, Array<string>),
    Journal(string, mutations_Journal),
    Step(string, mutations_Step),
    Job(string, processes_Job),
    Output(string, JobEvent),
    ArchivedJob(string, processes_ArchivedJob),
    ArchivedPart(string, bytes)
}

public type NativeImage = {
    source_sha256: string,
    records: Array<NativeRecord>
};

public type MigrationReport = {
    source_sha256: string,
    rows: usize
};

// The complete original export retains timestamps, usage, parent, kind and data.
// The projection below contains only what the native history converter consumes.
public type ProjectEvent = {
    id: i64,
    role: string,
    kind: string,
    name: string,
    text: string
};

public type ProjectConversation = {
    id: string,
    workspace: string,
    title: string,
    compacted_through: i64,
    summary: string,
    archive: string,
    events: Array<ProjectEvent>
};

public type ProjectEdit = {
    id: string,
    session: string,
    workspace: string,
    phase: string,
    archive: string,
    paths: Array<SavedPath>
};

public type ProjectJob = {
    record: processes_ArchivedJob,
    chunks: Array<bytes>
};

// Conversations arrive in the source catalogue's updated-descending order.
// Edits arrive in ascending source journal mtime order, matching latest-undo selection.
public type ProjectImage = {
    source_sha256: string,
    projects: Array<string>,
    conversations: Array<ProjectConversation>,
    edits: Array<ProjectEdit>,
    jobs: Array<ProjectJob>
};

public flow edit_phases(phase: string) -> (string, string) {
    return match phase {
        "applied" => ("applied", "applied"),
        "undone" => ("undone", "restored"),
        "rolled_back" => ("rolled_back", "restored"),
        "applying" => ("interrupted", "applying"),
        _ => abort("unsupported old project edit phase"),
    };
}

public type PortableInfo = {
    id: string,
    workspace: string,
    title: string,
    metadata: string
};

public type PortableArchive = {
    format: string,
    session: PortableInfo,
    events: Array<ChatMessage>
};

public type LegacyInfo = {
    id: string,
    root: string,
    title: string,
    created: f64,
    updated: f64,
    parent: JsonValue,
    compacted_through: i64,
    summary: string,
    usage: string
};

public type LegacyEvent = {
    id: i64,
    session: string,
    role: string,
    kind: string,
    name: string,
    content: string,
    data: JsonValue,
    created: f64
};

public type LegacyArchive = {
    format: string,
    session: LegacyInfo,
    events: Array<LegacyEvent>
};

public type ExportPreview = {
    path: string,
    content: string
};

public type ExportOutcome = {
    path: string,
    status: string
};

public type ExportMetadata = {
    format: string,
    conversation: history_Session,
    attempts: Array<lifecycle_Attempt>,
    copies: Array<CopyJob>
};

public type Imported = {
    title: string,
    events: Array<ChatMessage>,
    summary: string
};

public enum ArchiveDocument {
    Metadata(ExportMetadata),
    Conversation(PortableArchive),
    Outcome(ExportOutcome)
}
