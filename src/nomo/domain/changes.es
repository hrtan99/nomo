module nomo.domain.changes;

import nomo.domain.wire.{value as json_value, fields};
import std.json.JsonValue;
import std.text.{count, replace_n, rsplit_once};

/// create/write/edit/mkdir/delete/move; unused target/text fields are empty.
public type Change = {
    operation: FileChangeOperation,
    path: string,
    target: string,
    text: string
};

public type PlanRequest = {
    format: string,
    changes: Array<RawChange>
};

public type ChangeOutcome = {
    edit: string,
    status: ChangeStatus,
    completed: i64,
    message: string
};

public type FilePreview = {
    path: string,
    before: string,
    after: string
};

public type FileChange = {
    path: string,
    before: string,
    after: string
};

public type FileOutcome = {
    path: string,
    status: ChangeStatus,
    edit: string
};

public flow parent(name: string) -> string {
    return match rsplit_once(name, "/") {
        Some((directory, _)) => directory,
        None() => "."
    };
}

public flow below_root(normalized: string) -> string {
    if normalized == "" || normalized == "." {
        abort("file changes require a path below the project root");
    }
    return normalized;
}

public flow requires_existing(operation: FileChangeOperation) -> bool {
    return operation == FileChangeOperation.Delete || operation == FileChangeOperation.Move
        || operation == FileChangeOperation.Edit;
}

public flow creates_parents(operation: FileChangeOperation) -> bool {
    return operation == FileChangeOperation.Create || operation == FileChangeOperation.Write
        || operation == FileChangeOperation.Mkdir;
}

public flow content_change(operation: FileChangeOperation) -> bool {
    return operation == FileChangeOperation.Write || operation == FileChangeOperation.Create
        || operation == FileChangeOperation.Edit;
}

public flow restoring_phase(phase: StepPhase) -> bool {
    return phase == StepPhase.Applying || phase == StepPhase.Applied || phase == StepPhase.Restoring;
}

public flow completed_phase(phase: JournalPhase) -> bool {
    return phase == JournalPhase.Applied || phase == JournalPhase.Undone || phase == JournalPhase.RolledBack;
}

public flow file_request(name: string) -> bool {
    return name == "apply_changes" || name == "create_file" || name == "write_file"
        || name == "make_directory"
        || name == "delete_path" || name == "move_path" || name == "replace_file" || name == "edit_file";
}

public flow literal_after(original: string, target: string, replacement: string) -> Result<string, string> {
    if target == "" || count(original, target) != 1 {
        return Err("edit target must occur once");
    }
    return Ok(replace_n(original, target, replacement, 1));
}

public type FileJournal = {
    id: string,
    session: string,
    name: string,
    call: i64,
    phase: JournalPhase,
    steps: i64,
    message: string,
    owner_call: i64,
    owner_name: string
};

public type SavedPath = {
    path: string,
    before_exists: bool,
    before: string,
    after_exists: bool,
    after: string
};

public type FileStep = {
    phase: StepPhase,
    paths: Array<SavedPath>
};

public enum FileChangeOperation {
    Create,
    Write,
    Edit,
    Mkdir,
    Delete,
    Move
}

impl FileChangeOperation {
    public flow wire(self) -> string ![] {
        return match self {
            FileChangeOperation.Create => "create",
            FileChangeOperation.Write => "write",
            FileChangeOperation.Edit => "edit",
            FileChangeOperation.Mkdir => "mkdir",
            FileChangeOperation.Delete => "delete",
            FileChangeOperation.Move => "move"
        };
    }

    public flow parse(raw: string) -> FileChangeOperation ![] {
        return match raw {
            "create" => FileChangeOperation.Create,
            "write" => FileChangeOperation.Write,
            "edit" => FileChangeOperation.Edit,
            "mkdir" => FileChangeOperation.Mkdir,
            "delete" => FileChangeOperation.Delete,
            "move" => FileChangeOperation.Move,
            _ => abort("invalid FileChangeOperation spelling: " + raw)
        };
    }
}

public enum JournalPhase {
    Preparing,
    Applying,
    Applied,
    Failed,
    Undoing,
    Undone,
    RolledBack,
    Interrupted
}

impl JournalPhase {
    public flow wire(self) -> string ![] {
        return match self {
            JournalPhase.Preparing => "preparing",
            JournalPhase.Applying => "applying",
            JournalPhase.Applied => "applied",
            JournalPhase.Failed => "failed",
            JournalPhase.Undoing => "undoing",
            JournalPhase.Undone => "undone",
            JournalPhase.RolledBack => "rolled_back",
            JournalPhase.Interrupted => "interrupted"
        };
    }

    public flow parse(raw: string) -> JournalPhase ![] {
        return match raw {
            "preparing" => JournalPhase.Preparing,
            "applying" => JournalPhase.Applying,
            "applied" => JournalPhase.Applied,
            "failed" => JournalPhase.Failed,
            "undoing" => JournalPhase.Undoing,
            "undone" => JournalPhase.Undone,
            "rolled_back" => JournalPhase.RolledBack,
            "interrupted" => JournalPhase.Interrupted,
            _ => abort("invalid JournalPhase spelling: " + raw)
        };
    }
}

public enum StepPhase {
    Prepared,
    Applying,
    Applied,
    Restoring,
    Restored
}

impl StepPhase {
    public flow wire(self) -> string ![] {
        return match self {
            StepPhase.Prepared => "prepared",
            StepPhase.Applying => "applying",
            StepPhase.Applied => "applied",
            StepPhase.Restoring => "restoring",
            StepPhase.Restored => "restored"
        };
    }

    public flow parse(raw: string) -> StepPhase ![] {
        return match raw {
            "prepared" => StepPhase.Prepared,
            "applying" => StepPhase.Applying,
            "applied" => StepPhase.Applied,
            "restoring" => StepPhase.Restoring,
            "restored" => StepPhase.Restored,
            _ => abort("invalid StepPhase spelling: " + raw)
        };
    }
}

public enum ChangeStatus {
    Applied,
    Undone,
    RolledBack,
    RecoveryRequired,
    OriginalChanged,
    NoPendingRequest,
    RecordedResultRetained,
    NotDispatched,
    UndoNotStarted,
    RollbackNotStarted
}

impl ChangeStatus {
    public flow wire(self) -> string ![] {
        return match self {
            ChangeStatus.Applied => "applied",
            ChangeStatus.Undone => "undone",
            ChangeStatus.RolledBack => "rolled_back",
            ChangeStatus.RecoveryRequired => "recovery_required",
            ChangeStatus.OriginalChanged => "original_changed",
            ChangeStatus.NoPendingRequest => "no_pending_request",
            ChangeStatus.RecordedResultRetained => "recorded_result_retained",
            ChangeStatus.NotDispatched => "not_dispatched",
            ChangeStatus.UndoNotStarted => "undo_not_started",
            ChangeStatus.RollbackNotStarted => "rollback_not_started"
        };
    }

    public flow parse(raw: string) -> ChangeStatus ![] {
        return match raw {
            "applied" => ChangeStatus.Applied,
            "undone" => ChangeStatus.Undone,
            "rolled_back" => ChangeStatus.RolledBack,
            "recovery_required" => ChangeStatus.RecoveryRequired,
            "original_changed" => ChangeStatus.OriginalChanged,
            "no_pending_request" => ChangeStatus.NoPendingRequest,
            "recorded_result_retained" => ChangeStatus.RecordedResultRetained,
            "not_dispatched" => ChangeStatus.NotDispatched,
            "undo_not_started" => ChangeStatus.UndoNotStarted,
            "rollback_not_started" => ChangeStatus.RollbackNotStarted,
            _ => abort("invalid ChangeStatus spelling: " + raw)
        };
    }
}

impl JournalPhase {
    public flow final_status(self) -> ChangeStatus ![] {
        return match self {
            JournalPhase.Applied => ChangeStatus.Applied,
            JournalPhase.Undone => ChangeStatus.Undone,
            JournalPhase.RolledBack => ChangeStatus.RolledBack,
            _ => abort("unfinished journal has no final status")
        };
    }
}

public type RawChange = {
    operation: string,
    path: string,
    target: string,
    text: string
};
public flow decode_change(input: RawChange) -> Change ![] {
    return Change {
        operation = FileChangeOperation.parse(input.operation),
        path = input.path,
        target = input.target,
        text = input.text
    };
}

public flow wire_change(input: Change) -> RawChange ![] {
    return RawChange {
        operation = input.operation.wire(),
        path = input.path,
        target = input.target,
        text = input.text
    };
}

public flow wire_change_outcome(input: ChangeOutcome) -> JsonValue ![] {
    return fields(json_value(input), [("status", JsonValue.String(input.status.wire()))]);
}

public flow wire_file_outcome(input: FileOutcome) -> JsonValue ![] {
    return fields(json_value(input), [("status", JsonValue.String(input.status.wire()))]);
}

public flow wire_journal(input: FileJournal) -> JsonValue ![] {
    return fields(json_value(input), [("phase", JsonValue.String(input.phase.wire()))]);
}

public enum ChangeCommand {
    Apply(string, Array<Change>),
    Undo(string),
    Rollback(string),
    Reconcile(string)
}
