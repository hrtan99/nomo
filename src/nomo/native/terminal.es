module nomo.native.terminal;

import nomo.native.workspace.{CommandOutput, execute, execute_input};
import nomo.native.history.SessionContext;
import std.io.IOError;

/// Execute an allowlisted program in the project after native Host approval of its exact argv. Return its actual exit status, stdout and stderr.
public tool run_command(program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(program, arguments);
}

/// Send one complete UTF-8 stdin value to a foreground program after exact argv/stdin preview and native Host approval. Returns actual command output, without a retained process handle.
public tool run_command_input(program: string, arguments: Array<string>, input: string) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute_input(program, arguments, input);
}
