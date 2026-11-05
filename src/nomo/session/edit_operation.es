module nomo.session.edit_operation;

import std.text.{char_count as len, trim};
import nomo.core.text.{printable, hex_digest};
import nomo.tools.path_policy.valid_path;
import nomo.core.large_context.file_bytes;

public type Binding = { id: string, workspace: string, region: string, path: string,
    request_digest: string, before_digest: string, after_digest: string, before_bytes: usize, after_bytes: usize };
public type Record = { format: i32, phase: string, binding: Binding };

public flow selector_error(id: string, workspace: string, path: string) -> string {
    if len(id) == 0 || len(id) > 128 || len(workspace) == 0 || len(workspace) > 128 {
        return "invalid edit operation identity";
    }
    if !printable(id) || !printable(workspace) || trim(id) == "" || trim(workspace) == "" {
        return "invalid edit operation identity";
    }
    if !valid_path(path) { return "invalid relative path"; }
    return "";
}



public flow binding_error(value: Binding) -> string {
    let invalid = selector_error(value.id, value.workspace, value.path);
    if invalid != "" { return invalid; }
    if value.region != "nomo.tools.edit_file.EditableRoot" { return "edit region binding mismatch"; }
    if !hex_digest(value.request_digest) || !hex_digest(value.before_digest) || !hex_digest(value.after_digest) {
        return "invalid edit SHA-256 digest";
    }
    if value.before_bytes > file_bytes() || value.after_bytes > file_bytes() {
        return "invalid edit byte lengths";
    }
    if value.before_digest == value.after_digest { return "edit digests do not describe a change"; }
    return "";
}

public flow record_error(value: Record) -> string {
    if value.format != 1 || (value.phase != "intent" && value.phase != "completed") {
        return "invalid edit operation format or phase";
    }
    return binding_error(value.binding);
}

public flow same_binding(left: Binding, right: Binding) -> bool {
    return left.id == right.id && left.workspace == right.workspace && left.region == right.region && left.path == right.path &&
        left.request_digest == right.request_digest && left.before_digest == right.before_digest && left.after_digest == right.after_digest &&
        left.before_bytes == right.before_bytes && left.after_bytes == right.after_bytes;
}

public flow same_record(left: Record, right: Record) -> bool {
    return left.format == right.format && left.phase == right.phase && same_binding(left.binding, right.binding);
}
