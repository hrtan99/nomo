module nomo.adapters.filesystem.project_files;

import std.fs.{path, list, stat, relative_name, WorkspacePath, IOError as FileError, ReadLimitError};
import std.agent.message.Message;
import std.effects.Fs;
import nomo.native.workspace.ProjectRoot;
import nomo.application.workspace.ports.ProjectFileSource;
import nomo.domain.workspace.files.PathInfo;
import nomo.adapters.filesystem.file_io.read_text;

type Metadata = { is_file: bool, is_dir: bool, len: u64 };

flow location(pathname: string) -> WorkspacePath<ProjectRoot> {
    return match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => abort("invalid project path"),
    };
}

flow info(pathname: WorkspacePath<ProjectRoot>) -> PathInfo {
    let converted: Option<Message<Metadata>> = Message.new(stat(pathname)).cast<Metadata>();
    let metadata = match converted {
        Some(value) => value.body, None() => abort("filesystem metadata projection failed"),
    };
    return PathInfo { path = relative_name(pathname), is_file = metadata.is_file,
        is_dir = metadata.is_dir, bytes = metadata.len };
}

public type ProjectFiles = {};

impl ProjectFiles ~ ProjectFileSource {
    flow text(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] { return read_text(path); }
    flow entries(self, path: string) -> Array<PathInfo> ![Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Error<FileError>, Error<BudgetExceeded>] {
        return list(location(path)).iter().map_collect(item => info(item));
    }
    flow metadata(self, path: string) -> PathInfo ![Fs.stat<ProjectRoot>, Error<FileError>] { return info(location(path)); }
}
