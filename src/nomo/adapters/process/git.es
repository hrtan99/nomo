module nomo.adapters.process.git;

import nomo.application.commands.effects.CommandOperations;
import nomo.domain.execution.command.CommandOutput;
import nomo.application.commands.git.execute;
import nomo.domain.execution.git.GitRequest;
import std.io.IOError;
import nomo.application.conversation.session_context.SessionContext;

/// Read the current project's Git branch and working tree status.
public tool git_status() -> CommandOutput ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Status);
}

/// Read the working-tree or staged diff, optionally restricted to exact paths.
public tool git_diff(staged: bool, paths: Array<string>) -> CommandOutput
    ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Diff(staged, paths));
}

/// Read the most recent count commits.
public tool git_log(count: i32) -> CommandOutput
    ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Log(count));
}

/// List local branches.
public tool git_branches() -> CommandOutput ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Branches);
}

/// Initialize this project as a Git repository after native Host approval.
public tool git_init() -> CommandOutput ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Init);
}

/// Create a local branch after native Host approval.
public tool git_branch(name: string) -> CommandOutput ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Branch(name));
}

/// Switch to an existing branch after native Host approval.
public tool git_switch(name: string) -> CommandOutput ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Switch(name));
}

/// Stage selected paths, then commit. Each command receives its own Host approval.
public tool git_commit(message: string, paths: Array<string>) -> CommandOutput
    ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(GitRequest.Commit(message, paths));
}
