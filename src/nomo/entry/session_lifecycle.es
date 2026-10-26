module nomo.entry.session_lifecycle;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.collections.len as count;
import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import nomo.cli.session_lifecycle_args.{Request, parse, help_lines, topic_lines};
import nomo.session.harness_checkpoint.Identity;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.entry.harness_checkpoint_entry.run_init as initialize;
import nomo.entry.harness_checkpoint_entry.run_save as start;
import nomo.entry.harness_checkpoint_entry.run_show as show_first;
import nomo.entry.harness_successor_entry.run_continue as resume;
import nomo.entry.harness_successor_entry.run_show as show_successor;

// Display literal argv as JSON so spaces, quotes and flag-looking values retain
// their meaning. These are guidance data, never commands executed by Nomo.
flow display(label: string, values: Array<string>) -> unit {
    let message = Message.new(values);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body,
        None() => { println("GUIDANCE Use help for the command contract."); return; } };
    match stringify(json) { Ok(value) => { println(label + " " + value); }
        Err(_) => { println("GUIDANCE Use help for the command contract."); } }
}

flow help() -> unit { for line in help_lines() limit Iterations(16) { println(line); } }
flow refused(action: string, error: string) -> i32 {
    println("REFUSED session " + action + ": " + error); display("NEXT", ["help"]); return 1;
}
flow bindings(identity: Identity) -> Array<string> {
    var allowed = identity.allowed[0];
    if count(identity.allowed) == 2 { allowed = allowed + "," + identity.allowed[1]; }
    return ["--id", identity.id, "--workspace", identity.workspace, "--allow", allowed];
}
flow next(entry: string, args: Array<string>) -> unit {
    var values = [entry]; for value in args limit Iterations(10) { values = values.push(value); }
    display("NEXT", values);
}
flow successor_args(value: Request) -> Array<string> {
    let first = bindings(value.predecessor);
    let args = ["--id", value.predecessor.id, "--successor", value.successor.id,
        first[2], first[3], first[4], first[5]];
    return args;
}
flow incomplete(identity: Identity, args: Array<string>) -> i32 {
    display("SESSION", [identity.id, "completion-unconfirmed"]);
    println("GUIDANCE No new completed publication is confirmed. Do not automatically retry; show accepts published data only.");
    next("show", args); return 1;
}

public flow run_help(args: Array<string>) -> i32 {
    let value = match parse("help", args) { Ok(item) => item, Err(error) => { return refused("help", error); } };
    for line in topic_lines(value.request) limit Iterations(16) { println(line); }
    return 0;
}

public flow run_init(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    let value = match parse("init", args) { Ok(item) => item, Err(error) => { return refused("init", error); } };
    if value.help { help(); return 0; }
    if initialize(args) != 0 { return incomplete(value.predecessor, bindings(value.predecessor)); }
    display("SESSION", [value.predecessor.id, "initialized", "remaining-turns", "2"]);
    next("new", bindings(value.predecessor).push("--once").push("<request>")); return 0;
}

public flow run_new(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let value = match parse("new", args) { Ok(item) => item, Err(error) => { return refused("new", error); } };
    if value.help { help(); return 0; }
    if start(args) != 0 { return incomplete(value.predecessor, bindings(value.predecessor)); }
    display("SESSION", [value.predecessor.id, "published-first", "remaining-turns", "1"]);
    let first = bindings(value.predecessor);
    next("resume", ["--id", value.predecessor.id, "--successor", "<successor-id>",
        first[2], first[3], first[4], first[5], "--once", "<request>"]); return 0;
}

public flow run_resume(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let value = match parse("resume", args) { Ok(item) => item, Err(error) => { return refused("resume", error); } };
    if value.help { help(); return 0; }
    if resume(args) != 0 { return incomplete(value.successor, successor_args(value)); }
    display("SESSION", [value.successor.id, "published-successor", "predecessor", value.predecessor.id, "remaining-turns", "0"]);
    next("show", successor_args(value)); return 0;
}

// Separate callgraph and bin profile. Show never reaches mutation or inference.
public flow run_show(args: Array<string>) -> i32 {
    let value = match parse("show", args) { Ok(item) => item, Err(error) => { return refused("show", error); } };
    if value.help { help(); return 0; }
    let status = if value.successor_show { show_successor(args) } else { show_first(args) };
    if status != 0 {
        if value.successor_show { return incomplete(value.successor, successor_args(value)); }
        return incomplete(value.predecessor, bindings(value.predecessor));
    }
    if value.successor_show {
        display("SESSION", [value.successor.id, "displayed-successor", "predecessor", value.predecessor.id, "remaining-turns", "0"]);
        next("show", successor_args(value));
    } else {
        display("SESSION", [value.predecessor.id, "displayed-first"]);
        println("GUIDANCE Displaying a first checkpoint does not establish an unused continuation.");
        display("NEXT", ["help"]);
    }
    return 0;
}
