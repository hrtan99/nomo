module nomo.entry.harness_checkpoint_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_checkpoint_args.parse;
import nomo.harness.harness_tool_chat_contract.fresh_invocation;
import nomo.harness.harness_tool_chat.run_turn;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.session.harness_checkpoint.{from_turn, encode};
import nomo.session.harness_checkpoint_store.{initialize, begin, publish, reload};

flow help() -> unit {
    println("Harness checkpoint flows: harness_checkpoint_init, harness_checkpoint_save, harness_checkpoint_show.");
    println("Each requires --id ID --workspace BIND --allow FILE[,FILE]; save additionally requires --once TEXT.");
    println("Use a fresh exclusive project-owned directory: init once, save one successful settled first turn, then separate-process show by exact identity.");
    println("Original request, delegated task, actual records/results and allowance ledgers persist. Show is data-only; no model, File replay, executable continuation or repair.");
}

flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

public flow run_init(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    let options = match parse(args, false) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    match initialize(options.identity) { Ok(_) => {} Err(error) => { return refused(error); } }
    println("INITIALIZED Harness checkpoint owner " + options.identity.id);
    return 0;
}

public flow run_save(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let options = match parse(args, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    match begin(options.identity) { Ok(_) => {} Err(error) => { return refused(error); } }
    println("TURN 1 USER " + options.request);
    let turn = run_turn(options.request, options.identity.allowed, fresh_invocation());
    if turn.status != 0 || !turn.resolved { return refused("Harness turn did not complete; checkpoint not published"); }
    let saved = match from_turn(options.identity, turn) { Ok(value) => value, Err(error) => { return refused(error); } };
    match publish(saved) { Ok(_) => {} Err(error) => { return refused(error); } }
    println("SAVED Harness checkpoint " + options.identity.id);
    return 0;
}

// Separate callgraph: no run_turn, initialization or write operation is reachable.
public flow run_show(args: Array<string>) -> i32 {
    let options = match parse(args, false) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    let saved = match reload(options.identity) { Ok(value) => value, Err(error) => { return refused(error); } };
    let body = match encode(saved) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("CHECKPOINT " + body);
    return 0;
}
