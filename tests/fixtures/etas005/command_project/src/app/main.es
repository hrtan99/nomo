module app.main;

import std.host.command.Command;
import std.host.command.CommandResult;
import std.host.command.run;

public flow run_command(command: Command) -> CommandResult ![Command.run<DefaultCommandSandbox>]
{
    return run(command, DefaultCommandSandbox);
}

flow main(args: Array<string>) -> i32
{
    return 0;
}
