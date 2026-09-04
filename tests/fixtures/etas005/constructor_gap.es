module etas005.constructor_gap;

import std.host.command.Command;

flow main(args: Array<string>) -> i32
{
    let _command = Command {
        argv = ["/bin/sh", "-c", "printf unreachable"],
        env = [],
        cwd = None,
        stdin = None,
    };
    return 0;
}
