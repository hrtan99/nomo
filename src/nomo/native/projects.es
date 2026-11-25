module nomo.native.projects;

import std.fs.{Region, path, atomic_replace};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.codec.text.utf8_encode;
import std.io.{println, print, read_line};
import std.io.IOError as ConsoleError;
import std.text.{trim, from_usize};
import nomo.domain.projects.selection.{ProjectReference, remembered, reference, saved};
import nomo.core.json.encode;

public type LaunchRoot;
impl LaunchRoot ~ Region;
alias Schema = MemoryRegion<{ Recent: Store<string, Array<string>> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-projects-v1", store = "native-projects");

flow recent() -> Array<string> {
    return match Data.Recent.get("folders") { Some(value) => value, None() => [] };
}

public flow remember(workspace: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    Data.Recent.put("folders", remembered(workspace, recent()));
}

public flow show_projects() -> unit {
    var index: usize = 1;
    for value in recent() limit Iterations(2147483647) {
        println("[PROJECT] " + from_usize(index) + " " + value);
        index = index + 1;
    }
}

// The source selects the next folder. The launcher only transports this
// mount request to that folder's execution endpoint; it does not select a
// conversation or own the current endpoint's task lifecycle.
public flow request_open(raw: string, workspace: string) -> bool
    ![Memory, Console, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<FileError>, Error<ConsoleError>, Error<IndexError>] {
    var selection = trim(raw);
    if selection == "" {
        show_projects();
        print("project> folder path or saved number (blank cancels): ");
        selection = trim(read_line());
        if selection == "" { return false; }
    }
    let selected = match reference(selection, workspace) {
        ProjectReference.Saved(index) => saved(recent(), index),
        ProjectReference.Folder(path) => path
    };
    let preview = match encode(selected, "project path conversion failed", "project path encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
    println("[OPEN   ] " + preview);
    let destination = match path<LaunchRoot>("next-project") { Ok(value) => value, Err(_) => { abort("native launch control is unavailable"); } };
    atomic_replace(destination, utf8_encode(selected));
    return true;
}
