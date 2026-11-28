module nomo.domain.changes;

import nomo.native.mutations.{Journal, SavedPath, Step};
import std.text.{count, replace_n, rsplit_once};

/// create/write/edit/mkdir/delete/move; unused target/text fields are empty.
public type Change = {
    operation: string,
    path: string,
    target: string,
    text: string
};

public type PlanRequest = {
    format: string,
    changes: Array<Change>
};

public type ChangeOutcome = {
    edit: string,
    status: string,
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
    status: string,
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

public flow requires_existing(operation: string) -> bool {
    return operation == "delete" || operation == "move" || operation == "edit";
}

public flow creates_parents(operation: string) -> bool {
    return operation == "create" || operation == "write" || operation == "mkdir";
}

public flow content_change(operation: string) -> bool {
    return operation == "write" || operation == "create" || operation == "edit";
}

public flow restoring_phase(phase: string) -> bool {
    return phase == "applying" || phase == "applied" || phase == "restoring";
}

public flow completed_phase(phase: string) -> bool {
    return phase == "applied" || phase == "undone" || phase == "rolled_back";
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
