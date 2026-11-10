module nomo.native.terminal;

import nomo.native.workspace.{CommandOutput, execute};
import nomo.native.history.SessionContext;
import std.io.IOError;

/// Execute an allowlisted program in the project after native Host approval of its exact argv. Return its actual exit status, stdout and stderr.
public tool run_command(program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(program, arguments);
}
