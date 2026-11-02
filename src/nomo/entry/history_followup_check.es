module nomo.entry.history_followup_check;

import std.io.println;
import std.collections.len as count;
import nomo.session.history_followup_check_guard.{start, finish};

// Internal launcher boundary. It is not exposed as a user command; the
// launcher retains the session lock while it runs the selected offline check.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    if count(args) == 3 && args[0] == "start" {
        match start(args[1], args[2]) { Ok(_) => { println("CHECK RESERVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
    }
    if count(args) == 5 && args[0] == "finish" {
        match finish(args[1], args[2], args[3], args[4]) { Ok(_) => { println("CHECK SAVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
    }
    println("REFUSED invalid internal check action"); return 1;
}
