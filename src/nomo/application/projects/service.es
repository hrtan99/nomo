module nomo.application.projects.service;

import std.text.trim;
import std.effects.Fs;
import std.fs.IOError as FileError;
import nomo.native.projects.LaunchRoot;
import nomo.domain.projects.selection.{ProjectReference, LaunchRequest, remembered, reference, saved};
import nomo.application.projects.ports.{RecentProjects, ProjectLaunchControl};
import nomo.application.projects.effects.ProjectDisplay;

public flow remember<R ~ RecentProjects>(recent: R, workspace: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    recent.save(remembered(workspace, recent.load()));
}
public flow show<R ~ RecentProjects>(recent: R) -> unit ![ProjectDisplay, Memory, Error<StorageError>] {
    var index: usize = 1;
    for value in recent.load() {
        perform ProjectDisplay.item(index, value);
        index = index + 1;
    }
}
public flow launch<L ~ ProjectLaunchControl>(control: L, request: LaunchRequest) -> unit
    ![ProjectDisplay, Fs.atomic_replace<LaunchRoot>, Error<FileError>] {
    perform ProjectDisplay.preview(request.workspace);
    control.publish(request);
}
public flow open<R ~ RecentProjects, L ~ ProjectLaunchControl>(recent: R, control: L, raw: string, workspace: string, arguments: Array<string>) -> bool
    ![ProjectDisplay, Memory, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<FileError>, Error<IndexError>] {
    var selection = trim(raw);
    if selection == "" {
        show(recent);
        selection = trim(perform ProjectDisplay.choose());
        if selection == "" { return false; }
    }
    let selected = match reference(selection, workspace) {
        ProjectReference.Saved(index) => saved(recent.load(), index),
        ProjectReference.Folder(path) => path
    };
    launch(control, LaunchRequest { workspace = selected, arguments });
    return true;
}
