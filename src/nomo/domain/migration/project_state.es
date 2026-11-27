module nomo.domain.migration.project_state;

import nomo.domain.mutations.models.SavedPath;

// The complete original export retains timestamps, usage, parent, kind and data.
// The projection below contains only what the native history converter consumes.
public type ProjectEvent = { id: i64, role: string, kind: string, name: string, text: string };
public type ProjectConversation = { id: string, workspace: string, title: string,
    compacted_through: i64, summary: string, archive: string, events: Array<ProjectEvent> };
public type ProjectEdit = { id: string, session: string, workspace: string, phase: string,
    archive: string, paths: Array<SavedPath> };
// Conversations arrive in the source catalogue's updated-descending order.
// Edits arrive in ascending source journal mtime order, matching latest-undo selection.
public type ProjectImage = { source_sha256: string, projects: Array<string>,
    conversations: Array<ProjectConversation>, edits: Array<ProjectEdit> };

public flow edit_phases(phase: string) -> (string, string) {
    return match phase {
        "applied" => ("applied", "applied"),
        "undone" => ("undone", "restored"),
        "rolled_back" => ("rolled_back", "restored"),
        "applying" => ("interrupted", "applying"),
        _ => abort("unsupported old project edit phase"),
    };
}
