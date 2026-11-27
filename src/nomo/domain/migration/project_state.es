module nomo.domain.migration.project_state;

// The complete original export retains timestamps, usage, parent, kind and data.
// The projection below contains only what the native history converter consumes.
public type ProjectEvent = { id: i64, role: string, kind: string, name: string, text: string };
public type ProjectConversation = { id: string, workspace: string, title: string,
    compacted_through: i64, summary: string, archive: string, events: Array<ProjectEvent> };
// Conversations arrive in the source catalogue's updated-descending order.
public type ProjectImage = { source_sha256: string, projects: Array<string>, conversations: Array<ProjectConversation> };
