module app.main;

import std.io.println;

spec Gate: trace = +Console;

flow main(args: Array<string>) -> i32 ![Error<IOError>]
    ~ Gate
{
    println("ETAS006_TRACE_SECRET");
    return 0;
}
