module nomo.domain.mutations.models;

public import nomo.native.mutations.{Journal, SavedPath, Step};

/// create/write/edit/mkdir/delete/move; unused target/text fields are empty.
public type Change = { operation: string, path: string, target: string, text: string };
public type PlanRequest = { format: string, changes: Array<Change> };
public type ChangeOutcome = { edit: string, status: string, completed: i64, message: string };
public type FilePreview = { path: string, before: string, after: string };

// Re-export the preserved passive contracts; storage and policy use one identity.

public type FileChange = { path: string, before: string, after: string };
public type FileOutcome = { path: string, status: string, edit: string };
