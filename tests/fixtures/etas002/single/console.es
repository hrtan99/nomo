module etas002.console;

import std.io.println;

flow main(args: Array<string>) -> i32 ![Error<IOError>]
{
    println("console boundary");
    return 0;
}
