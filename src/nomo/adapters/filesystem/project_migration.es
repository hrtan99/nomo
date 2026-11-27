module nomo.adapters.filesystem.project_migration;

import std.effects.Fs;
import std.fs.{IOError as FileError, ReadLimitError};
import nomo.application.migration.ports.{ProjectStateSource, MigrationRoot};
import nomo.domain.migration.project_state.{ProjectImage, ProjectConversation, ProjectEvent, ProjectEdit};
import nomo.adapters.filesystem.migration_packet.{read, integer};

// Original SQLite integer IDs travel as decimal strings, never JSON numbers.
type WireEvent = { id: string, role: string, kind: string, name: string, text: string };
type WireConversation = { id: string, workspace: string, title: string, compacted_through: string,
    summary: string, archive: string, events: Array<WireEvent> };
type Packet = { format: string, source_sha256: string, projects: Array<string>,
    conversations: Array<WireConversation>, edits: Array<ProjectEdit> };

public type ProjectStatePacket = {};
impl ProjectStatePacket ~ ProjectStateSource {
    flow load(self) -> ProjectImage ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>, Error<IndexError>] {
        let packet = read<Packet>();
        if packet.format != "nomo-project-state-2" { abort("unsupported project migration packet format"); }
        return ProjectImage { source_sha256 = packet.source_sha256, projects = packet.projects,
            edits = packet.edits,
            conversations = packet.conversations.iter().map(old => ProjectConversation {
                id = old.id, workspace = old.workspace, title = old.title,
                compacted_through = integer(old.compacted_through), summary = old.summary, archive = old.archive,
                events = old.events.iter().map(event => ProjectEvent { id = integer(event.id),
                    role = event.role, kind = event.kind, name = event.name, text = event.text }).collect()
            }).collect() };
    }
}
