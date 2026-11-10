module nomo.native.project;

import std.fs.{path, relative_name, list, WorkspacePath, ReadLimitError, IOError as FileError};
import std.effects.Fs;
import std.text.{split, rsplit_once};
import nomo.native.workspace.ProjectRoot;
import nomo.native.file_io.read_text;
import nomo.native.history.{SessionContext, observe_started, observe_finished};

public type ProjectInstruction = { scope: string, path: string, text: string };

flow location(name: string) -> WorkspacePath<ProjectRoot> {
    return match path<ProjectRoot>(name) { Ok(value) => value, Err(_) => { abort("invalid project instruction path"); } };
}

flow guide(scope: string) -> Option<ProjectInstruction> {
    let name = if scope == "." { "AGENTS.md" } else { scope + "/AGENTS.md" };
    for item in list(location(scope)) limit Iterations(2147483647) {
        if relative_name(item) == name {
            return Some(ProjectInstruction { scope = scope, path = name, text = read_text(name) });
        }
    }
    return None();
}

/// Root-to-leaf AGENTS.md files applying to an existing or proposed file.
/// Missing future parent directories stop discovery after their existing ancestors.
public flow load_instructions(pathname: string) -> Array<ProjectInstruction>
    ![Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] {
    let normalized = relative_name(location(pathname));
    let parent = match rsplit_once(normalized, "/") { Some((value, _)) => value, None() => "." };
    var result: Array<ProjectInstruction> = [];
    var scope = ".";
    match guide(scope) { Some(value) => { result = result.push(value); } None() => {} }
    for component in split(parent, "/") limit Iterations(2147483647) {
        if component == "." || component == "" { continue; }
        let next = if scope == "." { component } else { scope + "/" + component };
        var present = false;
        for item in list(location(scope)) limit Iterations(2147483647) {
            if relative_name(item) == next { present = true; }
        }
        if !present { break; }
        scope = next;
        match guide(scope) { Some(value) => { result = result.push(value); } None() => {} }
    }
    return result;
}

/// Read applicable project guidance before creating or changing a file. More specific scopes refine ancestor guidance; these files do not grant permission to execute operations.
public tool project_instructions(pathname: string) -> Array<ProjectInstruction>
    ![SessionContext, Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>] {
    let call = observe_started("project_instructions", pathname);
    let result = load_instructions(pathname);
    observe_finished("project_instructions", call, result);
    return result;
}
