module app.main;

import std.host.command.{Command, CommandResult, run};

public flow run_command(command: Command) -> CommandResult ![Command.run<DefaultCommandSandbox>]
{
    return run(command, DefaultCommandSandbox);
}

flow main(args: Array<string>) -> i32
{
    return 0;
}
