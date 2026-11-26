module nomo.bootstrap.projects;

import nomo.application.projects.service;
import std.effects.Fs;
import std.fs.IOError as FileError;
import std.io.IOError as ConsoleError;
import nomo.native.projects.LaunchRoot;
import nomo.application.projects.effects.{ProjectDisplay, ProjectOperations};
import nomo.adapters.storage.projects.NativeRecentProjects;
import nomo.adapters.filesystem.launch_control.NativeProjectLaunch;
import nomo.adapters.cli.projects.TerminalProjects;

flow display() -> ![ProjectDisplay => Console, Error<ConsoleError>] ![] {
    let renderer = TerminalProjects {};
    return handler {
        ProjectDisplay.item(index, path) => { renderer.item(index, path); resume; }
        ProjectDisplay.choose() => { resume renderer.choose(); }
        ProjectDisplay.preview(path) => { renderer.preview(path); resume; }
    };
}
public flow operations() -> ![ProjectOperations => Memory, Console, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ConsoleError>, Error<IndexError>] ![Memory] {
    let recent = NativeRecentProjects {}; let launch = NativeProjectLaunch {};
    return handler {
        ProjectOperations.remember(workspace) => { service.remember(recent, workspace); resume; }
        ProjectOperations.show() => { handle { service.show(recent) } with display(); resume; }
        ProjectOperations.open(raw, workspace) => { let result = handle { service.open(recent, launch, raw, workspace) } with display(); resume result; }
    };
}
