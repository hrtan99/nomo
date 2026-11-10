module nomo.native.terminal;

import nomo.native.workspace.{CommandOutput, execute, execute_input};
import nomo.native.history.SessionContext;
import std.io.IOError;
import nomo.native.configuration.SettingsContext;

public type CheckOutcome = { configured: bool, output: Array<CommandOutput> };

flow program_path(name: string) -> string {
    return match name { "python3" => "/usr/bin/python3", "git" => "/usr/bin/git", "sh" => "/bin/sh", _ => name };
}

/// Run the configured project check with exact argv preview and native approval. Empty configuration returns configured=false and no process result.
public tool check_project() -> CheckOutcome
    ![SessionContext, SettingsContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let settings = perform SettingsContext.current();
    var program = "";
    var arguments: Array<string> = [];
    for value in settings.check limit Iterations(2147483647) {
        if program == "" { program = value; } else { arguments = arguments.push(value); }
    }
    if program == "" { return CheckOutcome { configured = false, output = [] }; }
    return CheckOutcome { configured = true, output = [execute(program_path(program), arguments)] };
}

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
