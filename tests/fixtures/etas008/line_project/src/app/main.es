module app.main;

import std.io.eprintln;
import std.io.print;
import std.io.println;
import std.io.read_line;

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
