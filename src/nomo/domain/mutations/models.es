module nomo.domain.mutations.models;

/// create/write/edit/mkdir/delete/move; unused target/text fields are empty.
public type Change = { operation: string, path: string, target: string, text: string };
public type PlanRequest = { format: string, changes: Array<Change> };
public type ChangeOutcome = { edit: string, status: string, completed: i64, message: string };
public type FilePreview = { path: string, before: string, after: string };

// Views for application policy; the original Memory declarations stay in place.
public type Journal = { id: string, session: string, name: string, call: i64, phase: string, steps: i64, message: string, owner_call: i64, owner_name: string };
public type SavedPath = { path: string, before_exists: bool, before: string, after_exists: bool, after: string };
public type Step = { phase: string, paths: Array<SavedPath> };

public type FileChange = { path: string, before: string, after: string };
public type FileOutcome = { path: string, status: string, edit: string };
