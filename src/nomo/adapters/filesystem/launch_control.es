module nomo.adapters.filesystem.launch_control;

import std.fs.{path, atomic_replace, WorkspacePath, IOError as FileError};
import std.effects.Fs;
import std.codec.text.utf8_encode;
import nomo.native.projects.LaunchRoot;
import nomo.application.projects.ports.ProjectLaunchControl;

public type NativeProjectLaunch = {};
impl NativeProjectLaunch ~ ProjectLaunchControl {
    flow target(self) -> WorkspacePath<LaunchRoot> ![] { return match path<LaunchRoot>("next-project") { Ok(value) => value, Err(_) => { abort("native launch control is unavailable"); } }; }
    flow publish(self, target: WorkspacePath<LaunchRoot>, folder: string) -> unit ![Fs.atomic_replace<LaunchRoot>, Error<FileError>] { atomic_replace(target, utf8_encode(folder)); }
}
