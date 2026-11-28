module nomo.adapters.process.commands;

import nomo.application.execution.commands.{checks_run, commands_requests_execute, execute_input, git_execute};
import nomo.application.execution.ports.{CommandOperations, CommandRunner};
import nomo.application.scope.{SessionContext, SettingsContext};
import nomo.domain.commands.{CheckOutcome, CommandOutput, CommandRequest, GitRequest};
import nomo.native.workspace.ProjectRoot;
import std.codec.text.{Replace, utf8_decode, utf8_encode};
import std.fs.path;
import std.host.command.{Command as command_Command, run};
import std.io.IOError;

/// Run the configured project check with exact argv preview and native approval. Empty configuration returns configured=false and no process result.
public tool check_project() -> CheckOutcome
![
    SessionContext.current,
    CommandOperations,
    SettingsContext.current,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return checks_run();
}

/// Execute an allowlisted program in the project after native Host approval of its exact argv. Return its actual exit status, stdout and stderr.
public tool run_command(program: string, arguments: Array<string>) -> CommandOutput
![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return commands_requests_execute(program, arguments);
}

/// Send one complete UTF-8 stdin value to a foreground program after exact argv/stdin preview and native Host approval. Returns actual command output, without a retained process handle.
public tool run_command_input(program: string, arguments: Array<string>, input: string) -> CommandOutput
![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return execute_input(program, arguments, input);
}

public type HostCommandRunner = {};

flow text(value: bytes) -> string {
    return match utf8_decode(value, Replace) {
        Ok(decoded) => decoded,
        Err(_) => abort("command output decoding failed"),
    };
}

impl HostCommandRunner ~ CommandRunner {
    flow run(self, request: CommandRequest) -> CommandOutput ![
        Command.run<DefaultCommandSandbox>,
        Error<IOError>
    ] {
        let root = match path<ProjectRoot>(".") {
            Ok(value) => value,
            Err(_) => abort("project root is unavailable"),
        };
        var selected = command_Command.new(request.program, request.arguments).with_cwd(root);
        match request.stdin {
            Some(value) => {
                selected = selected.with_stdin(utf8_encode(value));
            }
            None() => (),
        }
        let result = run(selected, DefaultCommandSandbox);
        return CommandOutput {
            exit_code = result.exit_code,
            stdout = text(result.stdout),
            stderr = text(result.stderr)
        };
    }
}

/// Read the current project's Git branch and working tree status.
public tool git_status() -> CommandOutput ![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Status);
}

/// Read the working-tree or staged diff, optionally restricted to exact paths.
public tool git_diff(staged: bool, paths: Array<string>) -> CommandOutput
![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Diff(staged, paths));
}

/// Read the most recent count commits.
public tool git_log(count: i32) -> CommandOutput
![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Log(count));
}

/// List local branches.
public tool git_branches() -> CommandOutput ![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Branches);
}

/// Initialize this project as a Git repository after native Host approval.
public tool git_init() -> CommandOutput ![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Init);
}

/// Create a local branch after native Host approval.
public tool git_branch(name: string) -> CommandOutput ![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Branch(name));
}

/// Switch to an existing branch after native Host approval.
public tool git_switch(name: string) -> CommandOutput ![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Switch(name));
}

/// Stage selected paths, then commit. Each command receives its own Host approval.
public tool git_commit(message: string, paths: Array<string>) -> CommandOutput
![
    SessionContext.current,
    CommandOperations,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    return git_execute(GitRequest.Commit(message, paths));
}
