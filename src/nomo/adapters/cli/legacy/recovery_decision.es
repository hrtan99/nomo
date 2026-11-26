module nomo.adapters.cli.legacy.recovery_decision;

import std.io.{println, IOError as ConsoleError};
import nomo.adapters.storage.legacy.recovery_decision.abandon;

public flow run(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    if args.len() != 2 { println("REFUSED expected TARGET ID"); return 1; }
    match abandon(args[0], args[1]) {
        Ok(_) => { println("DECISION abandon recorded; prior outcome remains unknown and no retry is authorized."); return 0; }
        Err(error) => { println("REFUSED " + error); return 1; }
    }
}
