module nomo.native.navigation;

import std.fs.{path, list, stat, relative_name, WorkspacePath, IOError as FileError, ReadLimitError};
import std.agent.message.Message;
import std.effects.Fs;
import std.text.{lines, contains};
import nomo.native.workspace.ProjectRoot;
import nomo.native.files.read_text;
import nomo.native.history.{SessionContext, observe_started, observe_finished};

type Metadata = { is_file: bool, is_dir: bool, len: u64 };
public type PathInfo = { path: string, is_file: bool, is_dir: bool, bytes: u64 };
public type MatchLine = { path: string, line: usize, text: string };
type SearchRequest = { paths: Array<string>, literal: string };

flow location(pathname: string) -> WorkspacePath<ProjectRoot> {
    return match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => { abort("invalid project path"); }
    };
}

flow info(pathname: WorkspacePath<ProjectRoot>) -> PathInfo {
    let converted: Option<Message<Metadata>> = Message.new(stat(pathname)).cast<Metadata>();
    let metadata = match converted {
        Some(value) => value.body, None() => { abort("filesystem metadata projection failed"); }
    };
    return PathInfo { path = relative_name(pathname), is_file = metadata.is_file,
        is_dir = metadata.is_dir, bytes = metadata.len };
}

/// List the actual named entries and metadata in a project directory; use '.' for the root.
public tool list_directory(pathname: string) -> Array<PathInfo>
    ![SessionContext, Memory, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>] {
    let call = observe_started("list_directory", pathname);
    var entries: Array<PathInfo> = [];
    for item in list(location(pathname)) limit Iterations(2147483647) { entries = entries.push(info(item)); }
    observe_finished("list_directory", call, entries);
    return entries;
}

/// Read actual metadata for an explicit project path.
public tool stat_file(pathname: string) -> PathInfo
    ![SessionContext, Memory, Fs.stat<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>] {
    let call = observe_started("stat_file", pathname);
    let result = info(location(pathname));
    observe_finished("stat_file", call, result);
    return result;
}

/// Search exact UTF-8 text in selected files and return every matching line, numbered from one.
public tool search_files(paths: Array<string>, literal: string) -> Array<MatchLine>
    ![SessionContext, Memory, Fs.read<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>] {
    let call = observe_started("search_files", SearchRequest { paths = paths, literal = literal });
    var matches: Array<MatchLine> = [];
    for pathname in paths limit Iterations(2147483647) {
        var number: usize = 1;
        for line in lines(read_text(pathname)) limit Iterations(2147483647) {
            if contains(line, literal) { matches = matches.push(MatchLine { path = pathname, line = number, text = line }); }
            number = number + 1;
        }
    }
    observe_finished("search_files", call, matches);
    return matches;
}
