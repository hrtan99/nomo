module nomo.native.files;

import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import std.effects.Fs;
import nomo.native.workspace.ProjectRoot;
import nomo.native.history.{SessionContext, record, tool_finished, observe_started, observe_finished};
import nomo.native.mutations.{Change, apply_plan};
import nomo.native.project.{ProjectInstruction, load_instructions};
public import nomo.native.file_io.read_text;

public type FileContent = { path: string, text: string, instructions: Array<ProjectInstruction> };
public type FileChange = { path: string, before: string, after: string };
public type FileOutcome = { path: string, status: string, edit: string };

spec ScopedReplace: trace = +Fs.read<ProjectRoot> & +Fs.list<ProjectRoot> & +Fs.atomic_replace<ProjectRoot>
    & +Command.run<DefaultCommandSandbox> & +Console & +Error & +Memory & +SessionContext
    & -Fs.write<ProjectRoot>;

/// Read a UTF-8 project file, including while another operation awaits recovery.
public tool read_file(pathname: string) -> FileContent
    ![SessionContext, Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>] {
    let call = observe_started("read_file", pathname);
    let result = FileContent { path = pathname, text = read_text(pathname), instructions = load_instructions(pathname) };
    observe_finished("read_file", call, result);
    return result;
}

/// Replace an observed file through the native edit journal, with exact content preview and Host approval.
public tool replace_file(change: FileChange) -> FileOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>]
    ~ ScopedReplace {
    if read_text(change.path) != change.before {
        let call = record("tool_call", "replace_file", change, -1);
        let result = FileOutcome { path = change.path, status = "original_changed", edit = "" };
        tool_finished("replace_file", call, result);
        return result;
    }
    let result = apply_plan("replace_file", [Change { operation = "write", path = change.path, target = "", text = change.after }]);
    return FileOutcome { path = change.path, status = result.status, edit = result.edit };
}

/// Replace one uniquely occurring literal through the same undoable native journal.
public tool edit_file(pathname: string, target: string, replacement: string) -> FileOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>]
    ~ ScopedReplace {
    return from_literal(pathname, target, replacement);
}

flow from_literal(pathname: string, target: string, replacement: string) -> FileOutcome {
    let result = apply_plan("edit_file", [Change { operation = "edit", path = pathname, target = target, text = replacement }]);
    return FileOutcome { path = pathname, status = result.status, edit = result.edit };
}
