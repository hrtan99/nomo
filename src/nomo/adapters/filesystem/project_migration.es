module nomo.adapters.filesystem.project_migration;

import std.effects.Fs;
import std.fs.{IOError as FileError, ReadLimitError};
import std.bytes.from_array;
import std.text.parse_i32;
import nomo.application.migration.ports.{ProjectStateSource, MigrationRoot};
import nomo.domain.migration.project_state.{ProjectImage, ProjectConversation, ProjectEvent, ProjectEdit, ProjectJob};
import nomo.domain.process.archived_jobs.ArchivedJob;
import nomo.adapters.filesystem.migration_packet.{read, integer, size};

// Original SQLite integer IDs travel as decimal strings, never JSON numbers.
type WireEvent = { id: string, role: string, kind: string, name: string, text: string };
type WireConversation = { id: string, workspace: string, title: string, compacted_through: string,
    summary: string, archive: string, events: Array<WireEvent> };
type WireJob = { id: string, workspace: string, arguments: Array<string>, phase: string,
    exit_code: Option<string>, output_bytes: string, original: string, chunks: Array<Array<u8>> };
type Packet = { format: string, source_sha256: string, projects: Array<string>,
    conversations: Array<WireConversation>, edits: Array<ProjectEdit>, jobs: Array<WireJob> };

flow job(old: WireJob) -> ProjectJob {
    let exit_code = match old.exit_code {
        Some(text) => match parse_i32(text) { Ok(value) => Some(value), Err(_) => abort("migration job exit code is invalid"), },
        None() => None(),
    };
    return ProjectJob { record = ArchivedJob { id = old.id, workspace = old.workspace,
        arguments = old.arguments, phase = old.phase, exit_code, output_bytes = size(old.output_bytes),
        parts = old.chunks.len(), original = old.original },
        chunks = old.chunks.iter().map(data => from_array(data)).collect() };
}

public type ProjectStatePacket = {};
impl ProjectStatePacket ~ ProjectStateSource {
    flow load(self) -> ProjectImage ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>, Error<IndexError>] {
        let packet = read<Packet>();
        if packet.format != "nomo-project-state-3" { abort("unsupported project migration packet format"); }
        return ProjectImage { source_sha256 = packet.source_sha256, projects = packet.projects,
            edits = packet.edits, jobs = packet.jobs.iter().map(old => job(old)).collect(),
            conversations = packet.conversations.iter().map(old => ProjectConversation {
                id = old.id, workspace = old.workspace, title = old.title,
                compacted_through = integer(old.compacted_through), summary = old.summary, archive = old.archive,
                events = old.events.iter().map(event => ProjectEvent { id = integer(event.id),
                    role = event.role, kind = event.kind, name = event.name, text = event.text }).collect()
            }).collect() };
    }
}
