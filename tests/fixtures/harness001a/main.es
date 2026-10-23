module app.main;

import std.io.{println, read_all};
import std.text.{len, split, to_string_usize};
import std.collections.len as count;
import std.json.parse;
import std.agent.message.Message;
import nomo.harness_contract.{Job, ChildTask, ChildResult, Ledger, Exchange, Outcome, Reservation};
import nomo.harness.{admit, settle, run};
import nomo.harness_child.run as child_run;
import nomo.text.printable;

type Case = { label: string, mode: string, job: Job, child: ChildTask,
    reply: ChildResult, reservation: Reservation, accepted: bool,
    status: string, text: string, used: i32 };

public flow coordinator_pure() -> bool {
    let context: Array<string> = ["selected"];
    let job = Job { task = "recall:user", context = context, maximum = 16, spent = 0 };
    return match run(job) {
        Ok(value) => value.text == "child result: remembered: selected", Err(_) => false
    };
}

public flow child_pure() -> bool {
    let context: Array<string> = [];
    let value = child_run(ChildTask { id = "child-1", depth = 1, allowance = 3,
        task = "tool:echo:child", context = context });
    return value.text == "stub received: child" && value.used == 3;
}

flow fixed_admission_error(error: string) -> bool {
    return error == "invalid bounded child task" || error == "invalid selected context" ||
        error == "invalid parent step ledger" || error == "insufficient shared step budget" ||
        error == "invalid reservation";
}

flow printable_text(text: string) -> bool {
    for character in split(text, "") limit Iterations(1282) {
        if character != "" && !printable(character) { return false; }
    }
    return true;
}

flow assert_admission(item: Case) -> unit {
    let saved = item.job;
    match admit(item.job) {
        Ok(value) => {
            if !item.accepted { abort("admitted refused fixture"); }
            let expected_child = ChildTask { id = "child-1", depth = 1, allowance = 3,
                task = item.job.task, context = item.job.context };
            let expected_ledger = Ledger { maximum = item.job.maximum,
                spent = item.job.spent + 1, reserved = 4 };
            if value.job != saved || value.child != expected_child || value.ledger != expected_ledger {
                abort("reservation changed identity, context or shared ledger");
            }
            if value.ledger.spent + value.ledger.reserved > item.job.maximum { abort("reservation overspent"); }
        }
        Err(error) => {
            if item.accepted || !fixed_admission_error(error) { abort("unexpected admission refusal"); }
        }
    }
    if saved != item.job { abort("admission mutated selected job"); }
}

flow assert_outcome(item: Case, actual: Outcome) -> unit {
    let final = if item.status == "completed" { "child result: " + item.text }
        else { "child refused: " + item.text };
    let kind = if item.status == "completed" { "result" } else { "error" };
    let expected = Ledger { maximum = item.job.maximum,
        spent = item.job.spent + 2 + item.used, reserved = 0 };
    if actual.status != item.status || actual.text != final || actual.ledger != expected {
        abort("incorrect result consumption or shared settlement");
    }
    if actual.ledger.spent < item.job.spent || actual.ledger.spent > item.job.maximum {
        abort("settlement reset or overspent original budget");
    }
    let expected_messages = [
        Exchange { sender = "main", recipient = "child-1", kind = "request", child_id = "child-1", text = item.job.task },
        Exchange { sender = "child-1", recipient = "main", kind = kind, child_id = "child-1", text = item.text },
        Exchange { sender = "main", recipient = "main", kind = "consume", child_id = "child-1", text = final }
    ];
    if actual.messages != expected_messages || count(actual.messages) != 3 { abort("incorrect delegation message order"); }
    if len(actual.text) > 1280 || !printable_text(actual.text) { abort("unbounded parent answer"); }
    var characters: usize = 0;
    for message in actual.messages limit Iterations(3) {
        if !printable_text(message.text) { abort("non-printable exchange"); }
        characters = characters + len(message.text);
    }
    if characters > 4096 { abort("unbounded message content"); }
}

flow assert_run(item: Case) -> unit {
    let before = item.job;
    match run(item.job) {
        Ok(value) => {
            if !item.accepted { abort("executed unadmitted child"); }
            assert_outcome(item, value);
        }
        Err(error) => {
            if item.accepted || !fixed_admission_error(error) { abort("unexpected coordinator refusal"); }
        }
    }
    if before != item.job { abort("child mutated parent context"); }
}

flow assert_child(item: Case) -> unit {
    let before = item.child;
    let actual = child_run(item.child);
    let expected = ChildResult { id = item.child.id, status = item.status,
        text = item.text, used = item.used };
    if actual != expected { abort("incorrect actual child outcome or usage"); }
    if item.child != before { abort("child mutated selected context"); }
}

flow assert_settle(item: Case) -> unit {
    let admitted = match admit(item.job) { Ok(value) => value, Err(_) => { abort("invalid settlement fixture"); } };
    let reservation = if item.mode == "forged" { item.reservation } else { admitted };
    match settle(reservation, item.reply) {
        Ok(value) => {
            if !item.accepted { abort("accepted forged reservation"); }
            assert_outcome(item, value);
        }
        Err(error) => {
            if item.accepted || !fixed_admission_error(error) { abort("unexpected settlement refusal"); }
        }
    }
}

public flow main(args: Array<string>) -> i32 {
    let parsed = match parse(read_all()) { Ok(value) => value, Err(_) => { abort("invalid synthetic JSON"); } };
    let message = Message.new(parsed);
    let conversion: Option<Message<Array<Case>>> = message.cast<Array<Case>>();
    let fixtures = match conversion { Some(value) => value.body, None() => { abort("invalid fixture shape"); } };
    if count(fixtures) == 0 || count(fixtures) > 512 { abort("invalid fixture count"); }
    var ordinal: usize = 0;
    for item in fixtures limit Iterations(512) {
        println("CASE " + to_string_usize(ordinal) + " " + item.label);
        if item.mode == "run" { assert_run(item); }
        else if item.mode == "admit" { assert_admission(item); }
        else if item.mode == "child" { assert_child(item); }
        else if item.mode == "settle" || item.mode == "forged" { assert_settle(item); }
        else { abort("unknown synthetic fixture mode"); }
        println("PASS " + to_string_usize(ordinal) + " " + item.label);
        ordinal = ordinal + 1;
    }
    println("PASS HARNESS001A " + to_string_usize(count(fixtures)));
    return 0;
}
