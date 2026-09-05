module app.main;

import std.io.{eprintln, print, println, read_line};

spec LineTerminal: trace = +Console;

flow main(args: Array<string>) -> i32 ![Error<IOError>]
    ~ LineTerminal
{
    println("READY");
    let first = read_line();
    print("FIRST<");
    print(first);
    println(">");
    let second = read_line();
    print("SECOND<");
    print(second);
    println(">");
    eprintln("ERR_DONE");
    return 0;
}
