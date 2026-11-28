module nomo.domain.archives;

import nomo.domain.changes.{JournalPhase, StepPhase};
import nomo.domain.attempts.wire_attempt;
import nomo.domain.wire.{value as json_value, fields};
import nomo.domain.attempts.ExecutionAttempt as attempts_Attempt;
import nomo.domain.changes.{FileJournal as changes_Journal, SavedPath, FileStep as changes_Step};
import nomo.domain.conversation.{ChatMessage, SavedSession, StoredEvent};
import nomo.domain.processes.{ArchivedProcessJob as processes_ArchivedJob, ProcessJob as processes_Job, ProcessOutput};
import nomo.domain.settings.CachedConfiguration;
import std.json.JsonValue;

// Stored facts, including incomplete records, are copied without executing them.
public enum NativeRecord {
    Counter(string, i64),
    Selected(string, string),
    Session(string, SavedSession),
    Event(string, StoredEvent),
    Chunk(string, string),
    Copy(string, ConversationCopy),
    AttemptCounter(string, i64),
    ExecutionAttempt(string, attempts_Attempt),
    Configuration(string, CachedConfiguration),
    Projects(string, Array<string>),
    FileJournal(string, changes_Journal),
    FileStep(string, changes_Step),
    ProcessJob(string, processes_Job),
    Output(string, ProcessOutput),
    ArchivedProcessJob(string, processes_ArchivedJob),
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

public flow edit_phases(phase: string) -> (JournalPhase, StepPhase) {
    return match phase {
        "applied" => (JournalPhase.Applied, StepPhase.Applied),
        "undone" => (JournalPhase.Undone, StepPhase.Restored),
        "rolled_back" => (JournalPhase.RolledBack, StepPhase.Restored),
        "applying" => (JournalPhase.Interrupted, StepPhase.Applying),
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
    path: string
};

public type ExportMetadata = {
    format: string,
    conversation: SavedSession,
    attempts: Array<attempts_Attempt>,
    copies: Array<ConversationCopy>
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

public type ConversationCopy = {
    id: string,
    workspace: string,
    title: string,
    kind: CopyKind,
    source: string,
    digest: bytes,
    total: i64,
    cursor: i64,
    phase: CopyPhase
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

public flow wire_metadata(input: ExportMetadata) -> JsonValue ![] {
    return fields(
        json_value(input),
        [
            ("attempts", JsonValue.Array(input.attempts.iter().map(attempt => wire_attempt(attempt)).collect())),
            ("copies", JsonValue.Array(input.copies.iter().map(copy => wire_copy(copy)).collect()))
        ]
    );
}

public enum CopyKind {
    Fork,
    Import
}

impl CopyKind {
    public flow wire(self) -> string ![] {
        return match self {
            CopyKind.Fork => "fork",
            CopyKind.Import => "import"
        };
    }

    public flow parse(raw: string) -> CopyKind ![] {
        return match raw {
            "fork" => CopyKind.Fork,
            "import" => CopyKind.Import,
            _ => abort("invalid CopyKind spelling: " + raw)
        };
    }
}

public enum CopyPhase {
    Staging,
    Copying,
    Ready,
    Discarded
}

impl CopyPhase {
    public flow wire(self) -> string ![] {
        return match self {
            CopyPhase.Staging => "staging",
            CopyPhase.Copying => "copying",
            CopyPhase.Ready => "ready",
            CopyPhase.Discarded => "discarded"
        };
    }

    public flow parse(raw: string) -> CopyPhase ![] {
        return match raw {
            "staging" => CopyPhase.Staging,
            "copying" => CopyPhase.Copying,
            "ready" => CopyPhase.Ready,
            "discarded" => CopyPhase.Discarded,
            _ => abort("invalid CopyPhase spelling: " + raw)
        };
    }
}

public flow wire_copy(input: ConversationCopy) -> JsonValue ![] {
    return fields(
        json_value(input),
        [("kind", JsonValue.String(input.kind.wire())), ("phase", JsonValue.String(input.phase.wire()))]
    );
}

public flow wire_export_outcome(input: ExportOutcome) -> JsonValue ![] {
    return fields(json_value(input), [("status", JsonValue.String("applied"))]);
}
