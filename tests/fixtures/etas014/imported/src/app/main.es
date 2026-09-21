module app.main;

import std.collections.array_push;

flow main(args: Array<string>) -> i32 {
    let values: Array<i32> = [1];
    let appended = array_push(values, 2);
    return appended[1];
}
