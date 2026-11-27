module nomo.adapters.model.tools.files;

import nomo.application.workspace.ports.WorkspaceObservations;
import nomo.application.conversation.session_context.SessionContext;
import nomo.application.mutations.ports.ChangeOperations;
import nomo.domain.workspace.files.{FileContent, PathInfo, MatchLine};
import nomo.domain.context.instructions.ProjectInstruction;
import nomo.domain.mutations.models.{Change, FileChange, FileOutcome};
import nomo.application.workspace.discovery;
import nomo.domain.execution.command.CommandOutput;
import nomo.application.commands.effects.CommandOperations;
import nomo.application.configuration.context.SettingsContext;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;

/// Read a UTF-8 project file, including while another operation awaits recovery.
public tool read_file(pathname: string) -> FileContent ![SessionContext.current, WorkspaceObservations] {
    return perform WorkspaceObservations.read(perform SessionContext.current(), pathname);
}

/// Read applicable project guidance before creating or changing a file. More specific scopes refine ancestor guidance; these files do not grant permission to execute operations.
public tool project_instructions(pathname: string) -> Array<ProjectInstruction> ![SessionContext.current, WorkspaceObservations] {
    return perform WorkspaceObservations.instructions(perform SessionContext.current(), pathname);
}

/// List the actual named entries and metadata in a project directory; use '.' for the root.
public tool list_directory(pathname: string) -> Array<PathInfo> ![SessionContext.current, WorkspaceObservations] {
    return perform WorkspaceObservations.list(perform SessionContext.current(), pathname);
}

/// Read actual metadata for an explicit project path.
public tool stat_file(pathname: string) -> PathInfo ![SessionContext.current, WorkspaceObservations] {
    return perform WorkspaceObservations.stat(perform SessionContext.current(), pathname);
}

/// Search exact UTF-8 text in selected files and return every matching line, numbered from one.
public tool search_files(paths: Array<string>, literal: string) -> Array<MatchLine> ![SessionContext.current, WorkspaceObservations] {
    return perform WorkspaceObservations.search(perform SessionContext.current(), paths, literal);
}

/// Discover files recursively with ripgrep's glob syntax and ignore rules. Empty glob uses normal ignore rules; an explicit glob has ripgrep's usual override precedence. depth=0 is unlimited. Exit 1 means no matches.
public tool find_files(pathname: string, glob: string, depth: i32) -> CommandOutput
    ![SessionContext.current, CommandOperations, SettingsContext.current, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
    return discovery.find_files(pathname, glob, depth);
}

/// Search a file or directory recursively. regex=true uses ripgrep regular expressions; false searches literal text. Results include actual path and line numbers. Exit 1 means no matches; exit 2 reports an error.
public tool search_project(pathname: string, pattern: string, regex: bool) -> CommandOutput
    ![SessionContext.current, CommandOperations, SettingsContext.current, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
    return discovery.search_project(pathname, pattern, regex);
}

spec ScopedReplace: trace = +Fs.read<ProjectRoot> & +Fs.list<ProjectRoot> & +Fs.atomic_replace<ProjectRoot>
    & +Command.run<DefaultCommandSandbox> & +Console & +Error & +Memory & +SessionContext
    & +ChangeOperations & +CommandOperations & -Fs.write<ProjectRoot>;

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
    let result = perform ChangeOperations.apply(perform SessionContext.current(), "edit_file", [Change { operation = "edit", path = pathname, target, text = replacement }]);
    return FileOutcome { path = pathname, status = result.status, edit = result.edit };
}
