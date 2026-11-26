module nomo.adapters.filesystem.files;

import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.commands.effects.CommandOperations;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import std.effects.Fs;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.adapters.storage.conversations.{observe_started, observe_finished};
import nomo.domain.mutations.models.Change;
import nomo.adapters.model.tools.mutations.apply_plan;
import nomo.domain.context.instructions.ProjectInstruction;
import nomo.adapters.filesystem.instruction_tools.load_instructions;
public import nomo.adapters.filesystem.file_io.read_text;
public import nomo.domain.mutations.models.{FileChange, FileOutcome};
import nomo.application.mutations.ports.ChangeOperations;

public type FileContent = { path: string, text: string, instructions: Array<ProjectInstruction> };


spec ScopedReplace: trace = +Fs.read<ProjectRoot> & +Fs.list<ProjectRoot> & +Fs.atomic_replace<ProjectRoot>
    & +Command.run<DefaultCommandSandbox> & +Console & +Error & +Memory & +SessionContext
    & +ChangeOperations & +CommandOperations & -Fs.write<ProjectRoot>;

/// Read a UTF-8 project file, including while another operation awaits recovery.
public tool read_file(pathname: string) -> FileContent
    ![SessionContext.current, ProjectInstructions, Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>] {
    let call = observe_started("read_file", pathname);
    let result = FileContent { path = pathname, text = read_text(pathname), instructions = load_instructions(pathname) };
    observe_finished("read_file", call, result);
    return result;
}

/// Replace an observed file through the native edit journal, with exact content preview and Host approval.
public tool replace_file(change: FileChange) -> FileOutcome
    ![SessionContext.current, ChangeOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>]
    ~ ScopedReplace {
    return perform ChangeOperations.replace(perform SessionContext.current(), change);
}

/// Replace one uniquely occurring literal through the same undoable native journal.
public tool edit_file(pathname: string, target: string, replacement: string) -> FileOutcome
    ![SessionContext.current, ChangeOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>]
    ~ ScopedReplace {
    return from_literal(pathname, target, replacement);
}

flow from_literal(pathname: string, target: string, replacement: string) -> FileOutcome {
    let result = apply_plan("edit_file", [Change { operation = "edit", path = pathname, target, text = replacement }]);
    return FileOutcome { path = pathname, status = result.status, edit = result.edit };
}
