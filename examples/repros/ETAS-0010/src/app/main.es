module app.main;

import std.text.parse_i32;

flow main(args: Array<string>) -> i32 {
    let parsed = parse_i32(args[0]);
    return match parsed {
        Ok(value) => value,
        Err(error) => -1,
    };
}
