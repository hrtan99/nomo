module nomo.domain.archives;

import nomo.domain.attempts.Attempt as attempts_Attempt;
import nomo.domain.changes.{Journal as changes_Journal, SavedPath, Step as changes_Step};
import nomo.domain.conversation.{ChatMessage, SavedSession, StoredEvent};
import nomo.domain.processes.{ArchivedJob as processes_ArchivedJob, Job as processes_Job, JobEvent};
import nomo.domain.settings.CachedConfiguration;
import std.json.JsonValue;

// Stored facts, including incomplete records, are copied without executing them.
public enum NativeRecord {
    Counter(string, i64),
    Selected(string, string),
    Session(string, SavedSession),
    Event(string, StoredEvent),
    Chunk(string, string),
    Copy(string, CopyJob),
    AttemptCounter(string, i64),
    Attempt(string, attempts_Attempt),
    Configuration(string, CachedConfiguration),
    Projects(string, Array<string>),
    Journal(string, changes_Journal),
    Step(string, changes_Step),
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
    conversation: SavedSession,
    attempts: Array<attempts_Attempt>,
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

public type CopyJob = {
    id: string,
    workspace: string,
    title: string,
    kind: string,
    source: string,
    digest: bytes,
    total: i64,
    cursor: i64,
    phase: string
};

// Encoded by the destination type's official codec after a checked direct
// old-to-new payload conversion. Integers never pass through JSON's f64.
public type RelocatedRow = {
    store: string,
    key: string,
    value: bytes
};

public type RelocatedImage = {
    format: string,
    source_sha256: string,
    rows: Array<RelocatedRow>
};
