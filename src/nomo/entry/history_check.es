module nomo.entry.history_check;

import std.io.{println, read_line};
import std.json.parse;
import std.collections.len as count;
import nomo.session.history_check_guard.{start, finish as first_finish};
import nomo.session.history_followup_check_guard.{start as followup_start, finish as followup_finish};

import nomo.session.check_output.{Record as OutputRecord, save as save_output};

// Internal launcher boundary. It is not exposed as a user command; the
// launcher retains the session lock while it runs the selected offline check.
public flow save_check_output(args: Array<string>, slot: string) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    if count(args) != 5 || (slot != "first" && slot != "followup") { println("REFUSED invalid internal check action"); return 1; }
    if (args[3] != "true" && args[3] != "false") || (args[4] != "true" && args[4] != "false") { println("REFUSED invalid output truncation flags"); return 1; }
    let raw = read_line();
    let parsed = match parse(raw) { Ok(item) => item, _ => { println("REFUSED invalid output transfer"); return 1; } };
    let message = Message.new(parsed);
    let typed: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let fields = match typed { Some(item) => item.body, None() => { println("REFUSED invalid output fields"); return 1; } };
    if count(fields) != 2 { println("REFUSED invalid output field count"); return 1; }
    let value = OutputRecord { format = 1, slot = slot, id = args[1], digest = args[2], stdout = fields[0], stderr = fields[1], stdout_truncated = args[3] == "true", stderr_truncated = args[4] == "true" };
    match save_output(value) { Ok(_) => { println("CHECK OUTPUT SAVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
}

public flow run_slot(args: Array<string>, followup: bool) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    if count(args) == 3 && args[0] == "start" {
        match (if followup { followup_start(args[1], args[2]) } else { start(args[1], args[2]) }) { Ok(_) => { println("CHECK RESERVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
    }
    if count(args) == 5 && args[0] == "finish" {
        match (if followup { followup_finish(args[1], args[2], args[3], args[4]) } else { first_finish(args[1], args[2], args[3], args[4]) }) { Ok(_) => { println("CHECK SAVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
    }
    if count(args) == 5 && args[0] == "output" { return save_check_output(args, if followup { "followup" } else { "first" }); }
    println("REFUSED invalid internal check action"); return 1;
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] { return run_slot(args, false); }
