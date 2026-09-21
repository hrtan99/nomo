module app.main;

import std.io.{println, read_line};
import std.runtime.checkpoint;

spec CheckpointSession: trace = +Console;

flow main(args: Array<string>) -> i32 ![Error<IOError>]
    ~ CheckpointSession
{
    println("BEFORE");
    checkpoint("after-before");
    println("AFTER");
    checkpoint("after-after");
    return 42;
}

flow blocking(args: Array<string>) -> i32 ![Error<IOError>]
    ~ CheckpointSession
{
    checkpoint("before-blocking-read");
    println("BLOCKING_READY");
    let ignored = read_line();
    return 0;
}
