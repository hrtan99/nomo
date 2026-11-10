module nomo.native.files;

import std.fs.{path, read_bytes_limited, atomic_replace, ReadLimitError};
import std.fs.IOError as FileError;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import std.codec.text.{utf8_decode, utf8_encode, Strict};
import nomo.core.json.encode;
import nomo.native.workspace.ProjectRoot;
import nomo.native.history.{SessionContext, record, tool_finished};
import std.text.{count, replace_n};

public type FileContent = { path: string, text: string };
public type FileChange = { path: string, before: string, after: string };
public type FileOutcome = { path: string, status: string };
type LiteralEdit = { path: string, target: string, replacement: string };

spec ScopedReplace: trace = +Fs.read<ProjectRoot> & +Fs.atomic_replace<ProjectRoot>
    & +Console & +Error & +Memory & +SessionContext
    & -Fs.write<ProjectRoot>;

public flow read_text(pathname: string) -> string {
    let location = match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => { abort("invalid project file path"); }
    };
    let text = match utf8_decode(read_bytes_limited(location, 536870912), Strict) {
        Ok(value) => value, Err(_) => { abort("project file is not UTF-8"); }
    };
    return text;
}

/// Read a UTF-8 project file before proposing edits.
public tool read_file(pathname: string) -> FileContent
    ![SessionContext, Memory, Fs.read<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>] {
    let call = record("tool_call", "read_file", pathname, -1);
    let result = FileContent { path = pathname, text = read_text(pathname) };
    tool_finished("read_file", call, result);
    return result;
}

/// Replace one existing file after approval of its exact path, before and after contents.
public tool replace_file(change: FileChange) -> FileOutcome
    ![SessionContext, Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>]
    ~ ScopedReplace {
    let call = record("tool_call", "replace_file", change, -1);
    return apply(change, call, "replace_file");
}

flow apply(change: FileChange, call: i64, name: string) -> FileOutcome {
    if read_text(change.path) != change.before {
        let result = FileOutcome { path = change.path, status = "original_changed" };
        tool_finished(name, call, result);
        return result;
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
    let result = FileOutcome { path = change.path, status = "applied" };
    tool_finished(name, call, result);
    return result;
}

/// Replace one exact, uniquely occurring literal in a UTF-8 file. Etas computes the full proposed file and obtains native write approval.
public tool edit_file(pathname: string, target: string, replacement: string) -> FileOutcome
    ![SessionContext, Memory, Console, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>]
    ~ ScopedReplace {
    let call = record("tool_call", "edit_file", LiteralEdit { path = pathname, target = target, replacement = replacement }, -1);
    let before = read_text(pathname);
    if target == "" || count(before, target) != 1 {
        let result = FileOutcome { path = pathname, status = "target_must_occur_once" };
        tool_finished("edit_file", call, result);
        return result;
    }
    let change = FileChange { path = pathname, before = before, after = replace_n(before, target, replacement, 1) };
    record("edit", "prepared_file", change, call);
    return apply(change, call, "edit_file");
}
