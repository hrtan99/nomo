module nomo.adapters.process.commands;

import nomo.application.commands.effects.CommandOperations;
import nomo.domain.execution.command.CommandOutput;
import nomo.application.commands.requests.{execute, execute_input};
import nomo.application.conversation.session_context.SessionContext;
import std.io.IOError;
import nomo.application.configuration.context.SettingsContext;

public import nomo.domain.execution.checks.CheckOutcome;
import nomo.application.commands.checks.run as run_check;

/// Run the configured project check with exact argv preview and native approval. Empty configuration returns configured=false and no process result.
public tool check_project() -> CheckOutcome
    ![SessionContext.current, CommandOperations, SettingsContext.current, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return run_check();
}

/// Execute an allowlisted program in the project after native Host approval of its exact argv. Return its actual exit status, stdout and stderr.
public tool run_command(program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute(program, arguments);
}

/// Send one complete UTF-8 stdin value to a foreground program after exact argv/stdin preview and native Host approval. Returns actual command output, without a retained process handle.
public tool run_command_input(program: string, arguments: Array<string>, input: string) -> CommandOutput
    ![SessionContext.current, CommandOperations, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute_input(program, arguments, input);
}
