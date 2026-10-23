module nomo.harness_chat;

import std.io.{println, read_line};
import std.text.to_string_i32;
import nomo.cli_request.{parse_args, parse_line};
import nomo.harness.run as coordinate;
import nomo.harness_contract.{Job, Outcome};

flow help() -> unit {
    println("Nomo harness chat (offline, serial, one child per turn): new");
    println("Limits: 3 admitted prompts, 16 raw lines, shared maximum 16 steps; tasks 1..256 characters.");
    println("Context: prior successful user tasks only; /help, /exit and EOF spend no steps.");
    println("Fresh in-memory only; no resume, one-shot, live model, real tools, concurrency or cancellation.");
}

flow emit(outcome: Outcome, turn: i32) -> unit {
    // child-1 is local to each coordinator call, so qualify every record by turn.
    let prefix = "TURN " + to_string_i32(turn) + " ";
    for message in outcome.messages limit Iterations(3) {
        println(prefix + "EVENT " + message.sender + " -> " + message.recipient + " " +
            message.kind + " " + message.child_id + ": " + message.text);
    }
    println(prefix + "FINAL " + outcome.status + ": " + outcome.text);
    println(prefix + "LEDGER maximum=" + to_string_i32(outcome.ledger.maximum) +
        " spent=" + to_string_i32(outcome.ledger.spent) + " reserved=" + to_string_i32(outcome.ledger.reserved));
}

flow stop(reason: string, turns: i32, spent: i32) -> unit {
    println("STOP " + reason + " turns=" + to_string_i32(turns) + " spent=" + to_string_i32(spent));
}

// HARNESS-002A: only line orchestration; parser, child policy and settlement stay
// in the accepted modules. No previous child answer is copied into context.
public flow run(args: Array<string>) -> i32 {
    let request = match parse_args(args) {
        Ok(value) => value,
        Err(error) => { println("REFUSED " + error); return 1; }
    };
    if request.kind == "help" { help(); return 0; }
    if request.kind != "new" {
        println("REFUSED resume is unavailable in the offline harness chat");
        return 1;
    }
    if request.once_supplied {
        println("REFUSED this line entry requires new without --once");
        return 1;
    }
    // This invocation alone owns the cumulative ledger and bounded selected data.
    var context: Array<string> = [];
    var spent: i32 = 0;
    var turns: i32 = 0;
    var lines: i32 = 0;
    println("Nomo harness chat (fresh, non-durable). /help for limits; /exit to quit.");
    while lines < 16 limit Iterations(16) {
        let raw = read_line();
        if raw == "" { stop("EOF", turns, spent); return 0; }
        lines = lines + 1;
        match parse_line(raw) {
            Err(error) => { println("REFUSED " + error); },
            Ok(command) => {
                if command.kind == "exit" { stop("exit", turns, spent); return 0; }
                if command.kind == "help" { help(); }
                else {
                    let job = Job { task = command.text, context = context, maximum = 16, spent = spent };
                    match coordinate(job) {
                        Err(error) => { println("REFUSED " + error); },
                        Ok(outcome) => {
                            turns = turns + 1;
                            spent = outcome.ledger.spent;
                            emit(outcome, turns);
                            if outcome.status != "completed" { stop("child refused", turns, spent); return 1; }
                            if turns == 3 { stop("turn limit", turns, spent); return 0; }
                            context = context.push(command.text);
                        }
                    };
                }
            }
        };
    }
    println("REFUSED line limit reached; start a new in-memory invocation");
    return 1;
}
