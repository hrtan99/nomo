module app.main;

import std.io.println;

spec ApprovalTerminal: trace = +Console;

flow main(args: Array<string>) -> i32 ![Error<IOError>]
    ~ ApprovalTerminal
{
    println("APPROVED_ACTION");
    return 0;
}
