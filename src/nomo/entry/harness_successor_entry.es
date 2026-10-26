module nomo.entry.harness_successor_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_successor_args.parse;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.session.harness_successor.{restore, from_turn, encode};
import nomo.session.harness_successor_store.{admit, failed, publish, reload};
import nomo.harness.harness_tool_chat.run_turn;

flow help() -> unit {
    println("Harness continuation: harness_checkpoint_continue and harness_successor_show.");
    println("Require --id OLD --successor NEW --workspace BIND --allow FILE[,FILE]; continue also requires --once TEXT.");
    println("One known owned first checkpoint admits exactly one new second turn under restored cumulative limits and selected prior.");
    println("Admission is consumed before model/tool work and is never reset. Failure or uncertain publication cannot be retried automatically.");
    println("Successor show is data-only. Original v1 checkpoint and completed tool outcomes remain intact; prior tools are not replayed.");
}

flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

public flow run_continue(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let options = match parse(args, true) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    let ticket = match admit(options.predecessor, options.successor, options.request) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    let invocation = match restore(ticket.predecessor.checkpoint) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("TURN 2 USER " + options.request);
    let turn = run_turn(options.request, options.predecessor.allowed, invocation);
    if turn.status != 0 || !turn.resolved {
        if turn.resolved { match failed(ticket, turn) { Ok(_) => {} Err(error) => { return refused(error); } } }
        return refused("Harness continuation did not complete; admission retained and successor not published");
    }
    let saved = match from_turn(options.successor, ticket.predecessor.checkpoint, ticket.predecessor.version.opaque, turn) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    match publish(ticket, saved) { Ok(_) => {} Err(error) => { return refused(error); } }
    println("SAVED Harness successor " + options.successor.id + " from " + options.predecessor.id);
    return 0;
}

public flow run_show(args: Array<string>) -> i32 {
    let options = match parse(args, false) { Ok(value) => value, Err(error) => { return refused(error); } };
    if options.help { help(); return 0; }
    let saved = match reload(options.predecessor, options.successor) { Ok(value) => value, Err(error) => { return refused(error); } };
    let body = match encode(saved) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("SUCCESSOR " + body);
    return 0;
}
