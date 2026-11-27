module nomo.adapters.filesystem.launch_control;

import std.fs.{path, atomic_replace, IOError as FileError};
import std.effects.Fs;
import std.codec.text.utf8_encode;
import nomo.native.projects.LaunchRoot;
import nomo.application.projects.ports.ProjectLaunchControl;
import nomo.domain.projects.selection.LaunchRequest;
import nomo.domain.serialization.json.encode;

public type NativeProjectLaunch = {};
impl NativeProjectLaunch ~ ProjectLaunchControl {
    flow publish(self, request: LaunchRequest) -> unit ![Fs.atomic_replace<LaunchRoot>, Error<FileError>] {
        let target = match path<LaunchRoot>("next-project") { Ok(value) => value, Err(_) => abort("native launch control is unavailable"), };
        let text = match encode(request, "launch request conversion failed", "launch request encoding failed") {
            Ok(value) => value, Err(error) => abort(error),
        };
        atomic_replace(target, utf8_encode(text));
    }
}
