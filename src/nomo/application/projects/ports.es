module nomo.application.projects.ports;

import std.fs.IOError as FileError;
import std.effects.Fs;
import std.io.IOError as ConsoleError;
import nomo.native.projects.LaunchRoot;

public spec RecentProjects {
    flow load(self) -> Array<string> ![Memory, Error<StorageError>];
    flow save(self, folders: Array<string>) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}
public spec ProjectLaunchControl {
    flow publish(self, path: string) -> unit ![Fs.atomic_replace<LaunchRoot>, Error<FileError>];
}
public spec ProjectRenderer {
    flow item(self, index: usize, path: string) -> unit ![Console, Error<ConsoleError>];
    flow choose(self) -> string ![Console, Error<ConsoleError>];
    flow preview(self, path: string) -> unit ![Console, Error<ConsoleError>];
}
