module app.help_probe;

import std.io.println;
import std.text.split;
import std.collections.len as count;
import nomo.entry.work_chain_help.{argument, help, show_hint, continue_hint};

type Check = { label: string, input: string, accepted: bool, expected: string };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow evaluate(item: Check) -> bool {
    return match argument(item.input) { Ok(value) => item.accepted && value == item.expected, Err(_) => !item.accepted };
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(32) { if !evaluate(item) { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(32) {
        if !evaluate(item) { println("FAIL " + item.label); abort("chain hint argument contract failed"); }
        println("PASS " + item.label);
        if item.accepted {
            let value = match argument(item.input) { Ok(value) => value, Err(error) => { abort(error); } };
            println("QUOTED " + item.label + " " + value);
        }
    }
    return 0;
}
public flow emit_help(args: Array<string>) -> i32 {
    let result = help(args); if result != 0 { abort("fixture observed native help refusal"); } return 0;
}
public flow emit_hints(args: Array<string>) -> i32 {
    if count(args) != 3 { abort("help fixture requires three selector arguments"); }
    show_hint(args[0], args[1], args[2]);
    continue_hint(args[0], args[1], args[2], ["a/b.txt", "c/d.txt"]);
    show_hint("invalid\nidentity", args[1], args[2]);
    continue_hint(args[0], args[1], args[2], ["../outside"]);
    return 0;
}
