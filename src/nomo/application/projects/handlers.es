module nomo.application.projects.handlers;

import nomo.application.projects.service;
import std.effects.Fs;
import std.fs.IOError as FileError;
import std.io.IOError as ConsoleError;
import nomo.native.projects.LaunchRoot;
import nomo.application.projects.effects.{ProjectDisplay, ProjectOperations};
import nomo.application.projects.ports.{RecentProjects, ProjectLaunchControl, ProjectRenderer};

flow display<R ~ ProjectRenderer>(renderer: R) -> ![ProjectDisplay => Console, Error<ConsoleError>] ![] {
    return handler {
        ProjectDisplay.item(index, path) => renderer.item(index, path);
        ProjectDisplay.choose() => renderer.choose();
        ProjectDisplay.preview(path) => renderer.preview(path);
    };
}
public flow operations<P ~ RecentProjects, L ~ ProjectLaunchControl, R ~ ProjectRenderer>(recent: P, launch: L, renderer: R) -> ![ProjectOperations => Memory, Console, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ConsoleError>, Error<IndexError>] ![] {
    let output = display(renderer);
    return handler {
        ProjectOperations.remember(workspace) => service.remember(recent, workspace);
        ProjectOperations.show() => handle service.show(recent) with output;
        ProjectOperations.open(raw, workspace, arguments) => handle service.open(recent, launch, raw, workspace, arguments) with output;
        ProjectOperations.launch(request) => handle service.launch(launch, request) with output;
    };
}
