module nomo.name_projection;

import std.fs.WorkspacePath;
import nomo.workspace.ReadOnlyRoot;

// Compile-negative evidence for the exact unavailable operation; never executed.
flow relative_name(value: WorkspacePath<ReadOnlyRoot>) -> string {
    return value.relative;
}
