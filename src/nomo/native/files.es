module nomo.native.files;

import std.fs.{path, read_bytes_limited, atomic_replace, ReadLimitError};
import std.fs.IOError as FileError;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import std.codec.text.{utf8_decode, utf8_encode, Strict};
import nomo.core.json.encode;
import nomo.native.workspace.ProjectRoot;

public type FileContent = { path: string, text: string };
public type FileChange = { path: string, before: string, after: string };
public type FileOutcome = { path: string, status: string };

spec ScopedReplace: trace = +Fs.read<ProjectRoot> & +Fs.atomic_replace<ProjectRoot>
    & +Console & +Error
    & -Fs.write<ProjectRoot>;

/// Read a UTF-8 project file before proposing edits.
public tool read_file(pathname: string) -> FileContent ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] {
    let location = match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => { abort("invalid project file path"); }
    };
    let text = match utf8_decode(read_bytes_limited(location, 536870912), Strict) {
        Ok(value) => value, Err(_) => { abort("project file is not UTF-8"); }
    };
    return FileContent { path = pathname, text = text };
}

/// Replace one existing file after approval of its exact path, before and after contents.
public tool replace_file(change: FileChange) -> FileOutcome
    ![Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>]
    ~ ScopedReplace {
    if read_file(change.path).text != change.before {
        return FileOutcome { path = change.path, status = "original_changed" };
    }
    let preview = match encode(change, "file preview conversion failed", "file preview encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
    println("[PREVIEW] " + preview);
    let location = match path<ProjectRoot>(change.path) {
        Ok(value) => value, Err(_) => { abort("invalid project file path"); }
    };
    // The runtime policy requests human approval for this pending Host write.
    // Its request owns the exact path/bytes; the source trace limits write actions.
    atomic_replace(location, utf8_encode(change.after));
    return FileOutcome { path = change.path, status = "applied" };
}
