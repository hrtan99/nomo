module app.main;

import std.io.println;

flow main(args: Array<string>) -> i32 ![Error<IOError>]
{
    println("profile console boundary");
    return 0;
}
