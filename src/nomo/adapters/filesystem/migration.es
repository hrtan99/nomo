module nomo.adapters.filesystem.migration;

import nomo.domain.archives.{CopyKind, CopyPhase};
import nomo.domain.processes.{JobPhase, JobEventKind, ArchivedJobPhase};
import nomo.domain.changes.SavedPath;
import nomo.domain.changes.{JournalPhase, StepPhase};
import nomo.domain.attempts.{AttemptKind, AttemptPhase};
import nomo.application.resources.MigrationRoot;
import nomo.application.transfer.ports.{NativeStateSource, ProjectStateSource, RelocatedStateSource};
import nomo.domain.archives.{
    ConversationCopy,
    NativeImage,
    NativeRecord,
    ProjectConversation,
    ProjectEdit,
    ProjectEvent,
    ProjectImage,
    ProjectJob,
    RelocatedImage,
    RelocatedRow
};
import nomo.domain.attempts.ExecutionAttempt;
import nomo.domain.changes.{FileJournal, FileStep};
import nomo.domain.conversation.{ConversationLedger, SavedSession, StoredEvent};
import nomo.domain.processes.{ArchivedProcessJob, ProcessJob, ProcessOutput};
import nomo.domain.settings.CachedConfiguration;
import std.agent.message.Message;
import std.bytes.from_array;
import std.codec.text.{Strict, utf8_decode};
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError, path, read_bytes_limited};
import std.json.parse;
import std.text.{parse_i32, parse_i64, parse_usize};

public type WireExitCode = {
    tag: string,
    values: Array<string>
};

public flow exit_code(value: WireExitCode) -> Option<i32> ![Error<IndexError>] {
    if value.tag == "None" && value.values.len() == 0 {
        return None();
    }
    if value.tag != "Some" || value.values.len() != 1 {
        abort("migration exit code has an invalid option");
    }
    return Some(
        match parse_i32(value.values[0]) {
            Ok(value) => value,
            Err(_) => abort("migration exit code is invalid"),
        }
    );
}

public flow decode<T>(text: string) -> T {
    let json = match parse(text) {
        Ok(value) => value,
        Err(_) => abort("migration packet is not JSON"),
    };
    let typed: Option<Message<T>> = Message.new(json).cast<T>();
    return match typed {
        Some(value) => value.body,
        None() => abort("migration packet has an invalid stored value"),
    };
}

public flow integer(text: string) -> i64 {
    return match parse_i64(text) {
        Ok(value) => value,
        Err(_) => abort("migration i64 is invalid"),
    };
}

public flow size(text: string) -> usize {
    return match parse_usize(text) {
        Ok(value) => value,
        Err(_) => abort("migration usize is invalid"),
    };
}

public flow read<T>() -> T ![Fs.read<MigrationRoot>, Error<fs_IOError>, Error<ReadLimitError>] {
    let source = match path<MigrationRoot>("snapshot.json") {
        Ok(value) => value,
        Err(_) => abort("migration packet path is unavailable"),
    };
    let text = match utf8_decode(read_bytes_limited(source, 536870912), Strict) {
        Ok(value) => value,
        Err(_) => abort("migration packet is not UTF-8"),
    };
    return decode<T>(text);
}

// Decimal strings preserve all old i64/usize values through JSON's number type.
type WireRow = {
    store: string,
    key: string,
    value: string
};

type NativeMigrationPacket = {
    format: string,
    source_sha256: string,
    rows: Array<WireRow>
};

type WireLedger = {
    turns: string,
    compactions: string,
    tools: string,
    generation_allowance: string,
    context_bytes: string
};

type WireSession = {
    id: string,
    workspace: string,
    title: string,
    next_event: string,
    first_user: string,
    summary_event: string,
    summary_through: string,
    pending: string,
    ledger: WireLedger
};

type NativeMigrationWireEvent = {
    role: string,
    name: string,
    call: string,
    chunks: string,
    complete: bool
};

type WireCopy = {
    id: string,
    workspace: string,
    title: string,
    kind: string,
    source: string,
    digest: Array<u8>,
    total: string,
    cursor: string,
    phase: string
};

type WireAttempt = {
    id: string,
    session: string,
    kind: string,
    label: string,
    phase: string,
    input_event: string,
    through: string,
    result_event: string,
    recovery_event: string
};

type WireCache = {
    digest: Array<u8>,
    session: string,
    result_event: string
};

type WireJournal = {
    id: string,
    session: string,
    name: string,
    call: string,
    phase: string,
    steps: string,
    message: string,
    owner_call: string,
    owner_name: string
};

type WireOutput = {
    job: string,
    call: string,
    phase: string,
    exit_code: WireExitCode,
    stdout: string,
    stderr: string,
    stdout_bytes: Array<u8>,
    stderr_bytes: Array<u8>
};

flow session(value: WireSession) -> SavedSession {
    let old = value.ledger;
    let ledger = ConversationLedger {
        turns = integer(old.turns),
        compactions = integer(old.compactions),
        tools = integer(old.tools),
        generation_allowance = integer(old.generation_allowance),
        context_bytes = size(old.context_bytes)
    };
    return SavedSession {
        id = value.id,
        workspace = value.workspace,
        title = value.title,
        next_event = integer(value.next_event),
        first_user = integer(value.first_user),
        summary_event = integer(value.summary_event),
        summary_through = integer(value.summary_through),
        pending = value.pending,
        ledger
    };
}

flow event(value: NativeMigrationWireEvent) -> StoredEvent {
    return StoredEvent {
        role = value.role,
        name = value.name,
        call = integer(value.call),
        chunks = size(value.chunks),
        complete = value.complete
    };
}

flow copy(value: WireCopy) -> ConversationCopy {
    return ConversationCopy {
        id = value.id,
        workspace = value.workspace,
        title = value.title,
        kind = CopyKind.parse(value.kind),
        source = value.source,
        digest = from_array(value.digest),
        total = integer(value.total),
        cursor = integer(value.cursor),
        phase = CopyPhase.parse(value.phase)
    };
}

flow attempt(value: WireAttempt) -> ExecutionAttempt {
    return ExecutionAttempt {
        id = value.id,
        session = value.session,
        kind = AttemptKind.parse(value.kind),
        label = value.label,
        phase = AttemptPhase.parse(value.phase),
        input_event = integer(value.input_event),
        through = integer(value.through),
        result_event = integer(value.result_event),
        recovery_event = integer(value.recovery_event)
    };
}

flow journal(value: WireJournal) -> FileJournal {
    return FileJournal {
        id = value.id,
        session = value.session,
        name = value.name,
        call = integer(value.call),
        phase = JournalPhase.parse(value.phase),
        steps = integer(value.steps),
        message = value.message,
        owner_call = integer(value.owner_call),
        owner_name = value.owner_name
    };
}

flow output(value: WireOutput) -> ProcessOutput ![Error<IndexError>] {
    return ProcessOutput {
        job = value.job,
        call = integer(value.call),
        phase = JobEventKind.parse(value.phase),
        exit_code = exit_code(value.exit_code),
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_bytes = from_array(value.stdout_bytes),
        stderr_bytes = from_array(value.stderr_bytes)
    };
}

flow record(row: WireRow) -> NativeRecord ![Error<IndexError>] {
    let key = row.key;
    return match row.store {
        "conversations.Counters" => NativeRecord.Counter(key, integer(decode<string>(row.value))),
        "conversations.Selected" => NativeRecord.Selected(key, decode<string>(row.value)),
        "conversations.Sessions" => NativeRecord.Session(key, session(decode<WireSession>(row.value))),
        "conversations.Events" => NativeRecord.Event(key, event(decode<NativeMigrationWireEvent>(row.value))),
        "conversations.Chunks" => NativeRecord.Chunk(key, decode<string>(row.value)),
        "copies.Jobs" => NativeRecord.Copy(key, copy(decode<WireCopy>(row.value))),
        "attempts.Counter" => NativeRecord.AttemptCounter(key, integer(decode<string>(row.value))),
        "attempts.Attempts" => NativeRecord.ExecutionAttempt(key, attempt(decode<WireAttempt>(row.value))),
        "configuration.Parsed" => {
            let value = decode<WireCache>(row.value);
            NativeRecord.Configuration(
                key,
                CachedConfiguration {
                    digest = from_array(value.digest),
                    session = value.session,
                    result_event = integer(value.result_event)
                }
            )
        },
        "projects.Recent" => NativeRecord.Projects(key, decode<Array<string>>(row.value)),
        "mutations.Journals" => NativeRecord.FileJournal(key, journal(decode<WireJournal>(row.value))),
        "mutations.Steps" => NativeRecord.FileStep(key, decode_step(decode<RawFileStep>(row.value))),
        "processes.Jobs" => NativeRecord.ProcessJob(key, native_job(decode<WireNativeJob>(row.value))),
        "processes.Outputs" => NativeRecord.Output(key, output(decode<WireOutput>(row.value))),
        _ => abort("unsupported native migration store: " + row.store),
    };
}

public type LegacyNativePacket = {};

impl LegacyNativePacket ~ NativeStateSource {
    flow load(self) -> NativeImage ![
        Fs.read<MigrationRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<IndexError>
    ] {
        let packet = read<NativeMigrationPacket>();
        if packet.format != "nomo-native-state-0135-v1" {
            abort("unsupported native migration packet format");
        }
        return NativeImage {
            source_sha256 = packet.source_sha256,
            records = packet.rows.iter().map(row => record(row)).collect()
        };
    }
}

// Original SQLite integer IDs travel as decimal strings, never JSON numbers.
type ProjectMigrationWireEvent = {
    id: string,
    role: string,
    kind: string,
    name: string,
    text: string
};

type WireConversation = {
    id: string,
    workspace: string,
    title: string,
    compacted_through: string,
    summary: string,
    archive: string,
    events: Array<ProjectMigrationWireEvent>
};

type WireJob = {
    id: string,
    workspace: string,
    arguments: Array<string>,
    phase: string,
    exit_code: WireExitCode,
    output_bytes: string,
    original: string,
    chunks: Array<Array<u8>>
};

type ProjectMigrationPacket = {
    format: string,
    source_sha256: string,
    projects: Array<string>,
    conversations: Array<WireConversation>,
    edits: Array<ProjectEdit>,
    jobs: Array<WireJob>
};

flow job(old: WireJob) -> ProjectJob ![Error<IndexError>] {
    return ProjectJob {
        record = ArchivedProcessJob {
            id = old.id,
            workspace = old.workspace,
            arguments = old.arguments,
            phase = ArchivedJobPhase.parse(old.phase),
            exit_code = exit_code(old.exit_code),
            output_bytes = size(old.output_bytes),
            parts = old.chunks.len(),
            original = old.original
        },
        chunks = old.chunks.iter().map(data => from_array(data)).collect()
    };
}

public type ProjectStatePacket = {};

impl ProjectStatePacket ~ ProjectStateSource {
    flow load(self) -> ProjectImage ![
        Fs.read<MigrationRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<IndexError>
    ] {
        let packet = read<ProjectMigrationPacket>();
        if packet.format != "nomo-project-state-3" {
            abort("unsupported project migration packet format");
        }
        return ProjectImage {
            source_sha256 = packet.source_sha256,
            projects = packet.projects,
            edits = packet.edits,
            jobs = packet.jobs.iter().map(old => job(old)).collect(),
            conversations = packet.conversations.iter().map(
                old => ProjectConversation {
                    id = old.id,
                    workspace = old.workspace,
                    title = old.title,
                    compacted_through = integer(old.compacted_through),
                    summary = old.summary,
                    archive = old.archive,
                    events = old.events.iter().map(
                        event => ProjectEvent {
                            id = integer(event.id),
                            role = event.role,
                            kind = event.kind,
                            name = event.name,
                            text = event.text
                        }
                    ).collect()
                }
            ).collect()
        };
    }
}

public type RelocatedStatePacket = {};

impl RelocatedStatePacket ~ RelocatedStateSource {
    flow load(self) -> RelocatedImage ![
        Fs.read<MigrationRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<IndexError>
    ] {
        let packet = read<RelocatedPacket>();
        if packet.format != "nomo-state-relocation-02413-v1" {
            abort("unsupported relocated state packet");
        }
        let rows = packet.rows.iter().map(row => relocated_row(row)).collect();
        return RelocatedImage {
            format = packet.format,
            source_sha256 = packet.source_sha256,
            rows
        };
    }
}

// Only row names/keys pass through JSON; typed storage payloads remain binary.
type RelocatedRowFile = {
    store: string,
    key: string,
    value: string
};
type RelocatedPacket = {
    format: string,
    source_sha256: string,
    rows: Array<RelocatedRowFile>
};

flow relocated_row(row: RelocatedRowFile) -> RelocatedRow ![
    Fs.read<MigrationRoot>,
    Error<fs_IOError>,
    Error<ReadLimitError>
] {
    let file = match path<MigrationRoot>(row.value) {
        Ok(value) => value,
        Err(_) => abort("invalid relocation row path")
    };
    return RelocatedRow {
        store = row.store,
        key = row.key,
        value = read_bytes_limited(file, 1048576)
    };
}

type RawFileStep = {
    phase: string,
    paths: Array<SavedPath>
};
flow decode_step(value: RawFileStep) -> FileStep ![] {
    return FileStep {
        phase = StepPhase.parse(value.phase),
        paths = value.paths
    };
}

type WireNativeJob = {
    id: string,
    session: string,
    program: string,
    arguments: Array<string>,
    handle: string,
    phase: string
};
flow native_job(input: WireNativeJob) -> ProcessJob ![] {
    return ProcessJob {
        id = input.id,
        session = input.session,
        program = input.program,
        arguments = input.arguments,
        handle = input.handle,
        phase = JobPhase.parse(input.phase)
    };
}
