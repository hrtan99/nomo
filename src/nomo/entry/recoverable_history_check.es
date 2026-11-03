module nomo.entry.recoverable_history_check;

import std.io.{println, read_line};
import std.json.parse;
import std.collections.len as count;
import std.effects.Fs;
import std.fs.IOError as FileError;
import std.io.IOError as ConsoleError;
import nomo.session.event_policy.{PolicyRoot, load as load_policy};
import nomo.session.recoverable_check_store.{start, finish};
import nomo.session.recoverable_followup_check_store.{start as start_followup, finish as finish_followup};
import nomo.session.continuous_work.{load as load_extra, start_check, finish_check};

// Called only by the launcher while it retains the session lock. No model or
// workspace capability is granted to this checkpoint process.
public flow run_mode(args: Array<string>, followup: bool) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) < 4 || args[0] != "--policy-binding" { println("REFUSED check policy binding required"); return 1; }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let binding = args[1]; var additional = false;
    if followup { let extra = match load_extra(binding) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } }; match extra { Some(item) => { if item.value.current.core.id == args[3] { additional = true; } } None() => {} } }
    if count(args) == 5 && args[2] == "start" {
        if additional { match start_check(binding, args[3], args[4]) { Ok(_) => { println("CHECK RESERVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } } }
        if followup { match start_followup(args[3], args[4], policy, binding) { Ok(_) => { println("CHECK RESERVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } } }
        match start(args[3], args[4], policy, binding) { Ok(_) => { println("CHECK RESERVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
    }
    if count(args) == 9 && args[2] == "finish" {
        if (args[7] != "true" && args[7] != "false") || (args[8] != "true" && args[8] != "false") { println("REFUSED invalid truncation flags"); return 1; }
        let parsed = match parse(read_line()) { Ok(item) => item, _ => { println("REFUSED invalid check output transfer"); return 1; } };
        let message: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
        let fields = match message { Some(item) => item.body, None() => { println("REFUSED invalid check output fields"); return 1; } };
        if count(fields) != 2 { println("REFUSED invalid check output field count"); return 1; }
        if additional { match finish_check(binding, args[3], args[4], args[5], args[6], fields[0], fields[1], args[7] == "true", args[8] == "true", policy) { Ok(_) => { println("CHECK AND SELECTED OUTPUT SAVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } } }
        if followup { match finish_followup(args[3], args[4], args[5], args[6], fields[0], fields[1], args[7] == "true", args[8] == "true", policy, binding) { Ok(_) => { println("CHECK AND SELECTED OUTPUT SAVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } } }
        match finish(args[3], args[4], args[5], args[6], fields[0], fields[1], args[7] == "true", args[8] == "true", policy, binding) { Ok(_) => { println("CHECK AND SELECTED OUTPUT SAVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
    }
    println("REFUSED invalid check action"); return 1;
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return run_mode(args, false); }
