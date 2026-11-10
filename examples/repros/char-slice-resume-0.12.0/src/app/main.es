module app.main;

import std.io.println;
import std.text.{get_char_slice, len, from_usize};

flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    var text = "x";
    var index = 0;
    while index < 17 limit Iterations(17) {
        text = text + text;
        index = index + 1;
    }
    println("SLICE_START");
    let selected = get_char_slice(text, Range.closed(0, 70000));
    match selected {
        Some(value) => { println("SLICE_BYTES " + from_usize(len(value))); }
        None() => { abort("valid slice returned None"); }
    }
    return 0;
}
