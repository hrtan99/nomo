module nomo.native.projects;

import std.fs.{Region, path, atomic_replace};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.codec.text.utf8_encode;
import std.io.{println, print, read_line};
import std.io.IOError as ConsoleError;
import std.text.{trim, parse_usize, from_usize, strip_prefix};
import std.collections.len;
import nomo.core.json.encode;

public type LaunchRoot;
impl LaunchRoot ~ Region;
alias Schema = MemoryRegion<{ Recent: Store<string, Array<string>> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-projects-v1", store = "native-projects");

flow recent() -> Array<string> {
    return match Data.Recent.get("folders") { Some(value) => value, None() => [] };
}

public flow remember(workspace: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    var folders = [workspace];
    for value in recent() limit Iterations(2147483647) { if value != workspace { folders = folders.push(value); } }
    Data.Recent.put("folders", folders);
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
    var selected = "";
    match parse_usize(selection) {
        Ok(index) => {
            let folders = recent();
            if index == 0 || index > len(folders) { abort("project number is outside the saved list"); }
            selected = folders[index - 1];
        }
        Err(_) => {
            selected = match strip_prefix(selection, "/") {
                Some(_) => selection,
                None() => { match strip_prefix(selection, "~/") { Some(_) => selection, None() => workspace + "/" + selection } }
            };
        }
    }
    let preview = match encode(selected, "project path conversion failed", "project path encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
    println("[OPEN   ] " + preview);
    let destination = match path<LaunchRoot>("next-project") { Ok(value) => value, Err(_) => { abort("native launch control is unavailable"); } };
    atomic_replace(destination, utf8_encode(selected));
    return true;
}
