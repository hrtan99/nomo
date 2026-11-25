module nomo.domain.projects.selection;

import std.text.{parse_usize, strip_prefix};
import std.collections.len;

public enum ProjectReference { Saved(usize), Folder(string) }

public flow remembered(workspace: string, recent: Array<string>) -> Array<string> {
    var folders = [workspace];
    for value in recent limit Iterations(2147483647) { if value != workspace { folders = folders.push(value); } }
    return folders;
}

public flow reference(selection: string, workspace: string) -> ProjectReference {
    return match parse_usize(selection) {
        Ok(index) => ProjectReference.Saved(index),
        Err(_) => ProjectReference.Folder(match strip_prefix(selection, "/") {
            Some(_) => selection,
            None() => { match strip_prefix(selection, "~/") { Some(_) => selection, None() => workspace + "/" + selection } }
        })
    };
}

public flow saved(folders: Array<string>, index: usize) -> string ![Error<IndexError>] {
    if index == 0 || index > len(folders) { abort("project number is outside the saved list"); }
    return folders[index - 1];
}
