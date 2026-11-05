module nomo.entry.harness_entry;

import std.io.println;
import std.text.from_i32;
import nomo.cli.cli_request.parse_args;
import nomo.harness.harness.run as coordinate;
import nomo.harness.harness_contract.Job;

flow help() -> unit {
    println("Nomo harness (offline, serial, one child): new --once TEXT");
    println("Task: 1..256 raw printable ASCII characters; shared maximum 5 steps.");
    println("Stub/fake echo only: plain text, tool:echo:TEXT, stub:fail, tool:echo:fail.");
    println("One-shot only; no durable session creation, resume, interactive input, live model or concurrency.");
}

// HARNESS-001B: the adapter adds only Console output, not a second agent policy.
public flow run(args: Array<string>) -> i32 {
    let request = match parse_args(args) {
        Ok(value) => value,
        Err(error) => { println("REFUSED " + error); return 1; }
    };
    if request.kind == "help" { help(); return 0; }
    if request.kind != "new" {
        println("REFUSED resume is unavailable in the offline harness entry");
        return 1;
    }
    if !request.once_supplied {
        println("REFUSED this entry requires new --once TEXT");
        return 1;
    }
    let context: Array<string> = [];
    // Pass exact raw data; admission enforces 256 before calling the child.
    let job = Job { task = request.once, context = context, maximum = 5, spent = 0 };
    let outcome = match coordinate(job) {
        Ok(value) => value,
        Err(error) => { println("REFUSED " + error); return 1; }
    };
    for message in outcome.messages limit Iterations(3) {
        println("EVENT " + message.sender + " -> " + message.recipient + " " + message.kind + " " + message.child_id + ": " + message.text);
    }
    println("FINAL " + outcome.status + ": " + outcome.text);
    println("LEDGER maximum=" + from_i32(outcome.ledger.maximum) +
        " spent=" + from_i32(outcome.ledger.spent) + " reserved=" + from_i32(outcome.ledger.reserved));
    if outcome.status != "completed" { return 1; }
    return 0;
}
