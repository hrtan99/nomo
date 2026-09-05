module app.main;

import std.io.{eprintln, print, println, read_line};

spec SingleLineTerminal: trace = +Console;

flow main(args: Array<string>) -> i32 ![Error<IOError>]
    ~ SingleLineTerminal
{
    println("READY");
    let input = read_line();
    print("INPUT<");
    print(input);
    println(">");
    eprintln("ERR_DONE");
    return 0;
}
