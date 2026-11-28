module nomo.adapters.cli.checkpoints;

import nomo.adapters.cli.checkpoint_input.{
    Request,
    harness_checkpoint_args_parse,
    harness_successor_args_parse,
    help_lines,
    session_lifecycle_args_parse,
    topic_lines
};
import nomo.adapters.storage.checkpoints.{
    admit,
    begin,
    failed,
    harness_checkpoint_store_publish,
    harness_checkpoint_store_reload,
    harness_successor_store_publish,
    harness_successor_store_reload,
    initialize
};
import nomo.bootstrap.harness.harness_tool_chat_run_turn;
import nomo.domain.harness.chat.fresh_invocation;
import nomo.domain.sessions.checkpoints.{
    checkpoint_encode,
    checkpoint_from_turn,
    restore,
    successor_encode,
    successor_from_turn
};
import nomo.session.harness_checkpoint.Identity;
import nomo.tools.workspace.ReadOnlyRoot;
import std.agent.message.Message;
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println};
import std.json.{JsonValue, stringify};

flow harness_checkpoint_entry_help() -> unit {
    println("Harness checkpoint flows: harness_checkpoint_init, harness_checkpoint_save, harness_checkpoint_show.");
    println("Each requires --id ID --workspace BIND --allow FILE[,FILE]; save additionally requires --once TEXT.");
    println("Use a fresh exclusive project-owned directory: init once, save one successful settled first turn, then separate-process show by exact identity.");
    println("Original request, delegated task, actual records/results and allowance ledgers persist. Show is data-only; no model, File replay, executable continuation or repair.");
}

flow harness_checkpoint_entry_refused(error: string) -> i32 {
    println("REFUSED " + error);
    return 1;
}

public flow harness_checkpoint_entry_run_init(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    let options = match harness_checkpoint_args_parse(args, false) {
        Ok(value) => value,
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    };
    if options.help {
        harness_checkpoint_entry_help();
        return 0;
    }
    match initialize(options.identity) {
        Ok(_) => (),
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    }
    println("INITIALIZED Harness checkpoint owner " + options.identity.id);
    return 0;
}

public flow run_save(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Fs.read<ReadOnlyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let options = match harness_checkpoint_args_parse(args, true) {
        Ok(value) => value,
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    };
    if options.help {
        harness_checkpoint_entry_help();
        return 0;
    }
    match begin(options.identity) {
        Ok(_) => (),
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    }
    println("TURN 1 USER " + options.request);
    let turn = harness_tool_chat_run_turn(options.request, options.identity.allowed, fresh_invocation());
    if turn.status != 0 || !turn.resolved {
        return harness_checkpoint_entry_refused("Harness turn did not complete; checkpoint not published");
    }
    let saved = match checkpoint_from_turn(options.identity, turn) {
        Ok(value) => value,
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    };
    match harness_checkpoint_store_publish(saved) {
        Ok(_) => (),
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    }
    println("SAVED Harness checkpoint " + options.identity.id);
    return 0;
}

// Separate callgraph: no run_turn, initialization or write operation is reachable.
public flow harness_checkpoint_entry_run_show(args: Array<string>) -> i32 {
    let options = match harness_checkpoint_args_parse(args, false) {
        Ok(value) => value,
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    };
    if options.help {
        harness_checkpoint_entry_help();
        return 0;
    }
    let saved = match harness_checkpoint_store_reload(options.identity) {
        Ok(value) => value,
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    };
    let body = match checkpoint_encode(saved) {
        Ok(value) => value,
        Err(error) => {
            return harness_checkpoint_entry_refused(error);
        }
    };
    println("CHECKPOINT " + body);
    return 0;
}

flow harness_successor_entry_help() -> unit {
    println("Harness continuation: harness_checkpoint_continue and harness_successor_show.");
    println("Require --id OLD --successor NEW --workspace BIND --allow FILE[,FILE]; continue also requires --once TEXT.");
    println("One known owned first checkpoint admits exactly one new second turn under restored cumulative limits and selected prior.");
    println("Admission is consumed before model/tool work and is never reset. Failure or uncertain publication cannot be retried automatically.");
    println("Successor show is data-only. Original v1 checkpoint and completed tool outcomes remain intact; prior tools are not replayed.");
}

flow harness_successor_entry_refused(error: string) -> i32 {
    println("REFUSED " + error);
    return 1;
}

public flow run_continue(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Fs.read<ReadOnlyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let options = match harness_successor_args_parse(args, true) {
        Ok(value) => value,
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    };
    if options.help {
        harness_successor_entry_help();
        return 0;
    }
    let ticket = match admit(options.predecessor, options.successor, options.request) {
        Ok(value) => value,
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    };
    let invocation = match restore(ticket.predecessor.checkpoint) {
        Ok(value) => value,
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    };
    println("TURN 2 USER " + options.request);
    let turn = harness_tool_chat_run_turn(options.request, options.predecessor.allowed, invocation);
    if turn.status != 0 || !turn.resolved {
        if turn.resolved {
            match failed(ticket, turn) {
                Ok(_) => (),
                Err(error) => {
                    return harness_successor_entry_refused(error);
                }
            }
        }
        return harness_successor_entry_refused("Harness continuation did not complete; admission retained and successor not published");
    }
    let saved = match successor_from_turn(
        options.successor,
        ticket.predecessor.checkpoint,
        ticket.predecessor.version.opaque,
        turn
    ) {
        Ok(value) => value,
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    };
    match harness_successor_store_publish(ticket, saved) {
        Ok(_) => (),
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    }
    println("SAVED Harness successor " + options.successor.id + " from " + options.predecessor.id);
    return 0;
}

public flow harness_successor_entry_run_show(args: Array<string>) -> i32 {
    let options = match harness_successor_args_parse(args, false) {
        Ok(value) => value,
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    };
    if options.help {
        harness_successor_entry_help();
        return 0;
    }
    let saved = match harness_successor_store_reload(options.predecessor, options.successor) {
        Ok(value) => value,
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    };
    let body = match successor_encode(saved) {
        Ok(value) => value,
        Err(error) => {
            return harness_successor_entry_refused(error);
        }
    };
    println("SUCCESSOR " + body);
    return 0;
}

// Display literal argv as JSON so spaces, quotes and flag-looking values retain
// their meaning. These are guidance data, never commands executed by Nomo.
flow display(label: string, values: Array<string>) -> unit {
    let message = Message.new(values);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion {
        Some(value) => value.body,
        None() => {
            println("GUIDANCE Use help for the command contract.");
            return;
        }
    };
    match stringify(json) {
        Ok(value) => println(
            label + " "
                + value
        ),
        Err(_) => println("GUIDANCE Use help for the command contract."),
    }
}

flow session_lifecycle_help() -> unit {
    @limits([Iterations(16)]) for line in help_lines() {
        println(line);
    }
}

flow session_lifecycle_refused(action: string, error: string) -> i32 {
    println("REFUSED session " + action + ": " + error);
    display("NEXT", ["help"]);
    return 1;
}

flow bindings(identity: Identity) -> Array<string> {
    var allowed = identity.allowed[0];
    if identity.allowed.len() == 2 {
        allowed = allowed + "," + identity.allowed[1];
    }
    return ["--id", identity.id, "--workspace", identity.workspace, "--allow", allowed];
}

flow next(entry: string, args: Array<string>) -> unit {
    let values = [entry].extend(args);
    display("NEXT", values);
}

flow successor_args(value: Request) -> Array<string> {
    let first = bindings(value.predecessor);
    let args = [
        "--id",
        value.predecessor.id,
        "--successor",
        value.successor.id,
        first[2],
        first[3],
        first[4],
        first[5]
    ];
    return args;
}

flow incomplete(identity: Identity, args: Array<string>) -> i32 {
    display("SESSION", [identity.id, "completion-unconfirmed"]);
    println("GUIDANCE No new completed publication is confirmed. Do not automatically retry; show accepts published data only.");
    next("show", args);
    return 1;
}

public flow run_help(args: Array<string>) -> i32 {
    let value = match session_lifecycle_args_parse("help", args) {
        Ok(item) => item,
        Err(error) => {
            return session_lifecycle_refused("help", error);
        }
    };
    @limits([Iterations(16)]) for line in topic_lines(value.request) {
        println(line);
    }
    return 0;
}

public flow session_lifecycle_run_init(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    let value = match session_lifecycle_args_parse("init", args) {
        Ok(item) => item,
        Err(error) => {
            return session_lifecycle_refused("init", error);
        }
    };
    if value.help {
        session_lifecycle_help();
        return 0;
    }
    if harness_checkpoint_entry_run_init(args) != 0 {
        return incomplete(value.predecessor, bindings(value.predecessor));
    }
    display("SESSION", [value.predecessor.id, "initialized", "remaining-turns", "2"]);
    next("new", bindings(value.predecessor).push("--once").push("<request>"));
    return 0;
}

public flow run_new(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Fs.read<ReadOnlyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let value = match session_lifecycle_args_parse("new", args) {
        Ok(item) => item,
        Err(error) => {
            return session_lifecycle_refused("new", error);
        }
    };
    if value.help {
        session_lifecycle_help();
        return 0;
    }
    if run_save(args) != 0 {
        return incomplete(value.predecessor, bindings(value.predecessor));
    }
    display("SESSION", [value.predecessor.id, "published-first", "remaining-turns", "1"]);
    let first = bindings(value.predecessor);
    next(
        "resume",
        [
            "--id",
            value.predecessor.id,
            "--successor",
            "<successor-id>",
            first[2],
            first[3],
            first[4],
            first[5],
            "--once",
            "<request>"
        ]
    );
    return 0;
}

public flow run_resume(args: Array<string>) -> i32 ![
    Console,
    Memory,
    Fs.read<ReadOnlyRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let value = match session_lifecycle_args_parse("resume", args) {
        Ok(item) => item,
        Err(error) => {
            return session_lifecycle_refused("resume", error);
        }
    };
    if value.help {
        session_lifecycle_help();
        return 0;
    }
    if run_continue(args) != 0 {
        return incomplete(value.successor, successor_args(value));
    }
    display(
        "SESSION",
        [value.successor.id, "published-successor", "predecessor", value.predecessor.id, "remaining-turns", "0"]
    );
    next("show", successor_args(value));
    return 0;
}

// Separate callgraph and bin profile. Show never reaches mutation or inference.
public flow session_lifecycle_run_show(args: Array<string>) -> i32 {
    let value = match session_lifecycle_args_parse("show", args) {
        Ok(item) => item,
        Err(error) => {
            return session_lifecycle_refused("show", error);
        }
    };
    if value.help {
        session_lifecycle_help();
        return 0;
    }
    let status = if value.successor_show {
        harness_successor_entry_run_show(args)
    } else {
        harness_checkpoint_entry_run_show(args)
    };
    if status != 0 {
        if value.successor_show {
            return incomplete(value.successor, successor_args(value));
        }
        return incomplete(value.predecessor, bindings(value.predecessor));
    }
    if value.successor_show {
        display(
            "SESSION",
            [value.successor.id, "displayed-successor", "predecessor", value.predecessor.id, "remaining-turns", "0"]
        );
        next("show", successor_args(value));
    } else {
        display("SESSION", [value.predecessor.id, "displayed-first"]);
        println("GUIDANCE Displaying a first checkpoint does not establish an unused continuation.");
        display("NEXT", ["help"]);
    }
    return 0;
}
