module app.main;

import std.io.{println, read_line};
import std.host.command.{command, run};
import std.option.unwrap;
import std.memory.version;

type Event = { sequence: i32, role: string, text: string };
type Budget = { consumed: i32, reserved: i32, unit: string };
type Operation = { id: string, state: string, result: string };
type Session = { schema: i32, id: string, ordinal: i32, events: Array<Event>, operation: Operation, budget: Budget };
type WorkspaceRecord = { schema: i32, generation: i32, sessions: Array<Session> };
alias Schema = MemoryRegion<{ Workspaces: Store<string, WorkspaceRecord> }>;
let State = std.memory.region<Schema>(stable_id = "arch001_sessions", store = "workspace");

flow record(generation: i32, state: string, text: string) -> WorkspaceRecord {
    return WorkspaceRecord {
        schema = 1, generation = generation,
        sessions = [
            Session { schema = 1, id = "session-a", ordinal = 1,
              events = [Event { sequence = 1, role = "user", text = text }],
              operation = Operation { id = "op-a", state = "completed", result = "saved" },
              budget = Budget { consumed = 7, reserved = 0, unit = "tokens" } },
            Session { schema = 1, id = "session-b", ordinal = 2,
              events = [Event { sequence = 1, role = "assistant", text = "intent" },
                        Event { sequence = 2, role = "tool", text = "bounded" }],
              operation = Operation { id = "op-b", state = state, result = "fixed-result" },
              budget = Budget { consumed = 11, reserved = 13, unit = "tokens" } }
        ]
    };
}

flow marker(target: string) -> unit {
    let result = run(command("/bin/sh", ["-c", "printf X >> \"$1\"", "arch001", target]), DefaultCommandSandbox);
}

flow main(args: Array<string>) -> i32 {
    let mode = args[0];
    if mode == "inspect-state" {
        let result = run(command("/bin/sh", ["-c", "exec 3< \"$1\"; exec 4<> \"$1\"; printf STATE_ACCESS > \"$2\"", "arch001", args[2], args[1]]), DefaultCommandSandbox);
        return 0;
    }
    if mode == "seed-secret" {
        let value = record(1, "pending", args[1]);
        State.Workspaces.insert("root", value);
        return 0;
    }
    if mode == "seed" {
        State.Workspaces.insert("root", record(1, "pending", "bounded-public-fixture"));
        println("SEEDED");
        return 0;
    }
    if mode == "writer" {
        println("BEFORE_INTENT");
        let before = read_line();
        State.Workspaces.insert("root", record(1, "pending", "bounded-public-fixture"));
        println("INTENT");
        let intent = read_line();
        marker(args[1]);
        println("EFFECT");
        let effect = read_line();
        State.Workspaces.put_versioned("root", record(2, "completed", "bounded-public-fixture"), version("1"));
        println("OUTCOME");
        let outcome = read_line();
        println("DISPLAY");
        return 0;
    }
    if mode == "cas" {
        let observed = unwrap(State.Workspaces.get("root"));
        if observed != record(1, "pending", "bounded-public-fixture") { abort("unexpected initial record"); }
        println("OBSERVED_ONE");
        let ready = read_line();
        let written = handle {
            State.Workspaces.put_versioned("root", record(2, "completed", "bounded-public-fixture"), version("1"));
            true
        } with {
            Error<MemoryConflict>.raise(conflict) => {
                if unwrap(conflict.expected).opaque != "1" { abort("wrong expected version"); }
                if unwrap(conflict.actual).opaque != "2" { abort("wrong actual version"); }
                finish false;
            }
        };
        if written { marker(args[1]); println("WON"); }
        else { println("CONFLICT"); }
        return 0;
    }
    if mode == "advance" {
        State.Workspaces.put_versioned("root", record(3, "completed", "bounded-public-fixture"), version("2"));
        println("THREE");
        return 0;
    }
    if mode == "bad-version" {
        State.Workspaces.put_versioned("root", record(2, "completed", "bounded-public-fixture"), version("invalid"));
        marker(args[1]);
        return 0;
    }
    if mode == "overflow" {
        State.Workspaces.put_versioned("root", record(2, "completed", "bounded-public-fixture"), version("9223372036854775807"));
        marker(args[1]);
        return 0;
    }
    if mode == "expected-existing" {
        State.Workspaces.put_versioned("root", record(2, "completed", "bounded-public-fixture"), version("1"));
        marker(args[1]);
        return 0;
    }
    let saved: WorkspaceRecord = match State.Workspaces.get("root") {
        Some(value) => value,
        None => { println("ABSENT"); return 0; },
    };
    if saved.schema != 1 { abort("unsupported workspace schema"); }
    if saved.sessions[0].schema != 1 || saved.sessions[1].schema != 1 { abort("unsupported session schema"); }
    if saved != record(saved.generation, saved.sessions[1].operation.state, "bounded-public-fixture") { abort("round-trip mismatch"); }
    if saved.generation == 1 { println("GEN_ONE"); }
    else if saved.generation == 2 { println("GEN_TWO"); }
    else if saved.generation == 3 { println("GEN_THREE"); }
    else { abort("invalid generation"); }
    println(saved.sessions[1].id);
    println(saved.sessions[1].operation.state);
    println(saved.sessions[1].operation.result);
    return 0;
}
