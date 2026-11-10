module nomo.native.lifecycle;

import std.memory.{get_entry, MemoryCursor};
import std.text.from_i64;
import nomo.native.history.{SessionContext, NativeHistory, ConversationStore, reserve_result, complete_result,
    complete_event, tool_finished, acknowledge_command, adopt_summary};

public type Attempt = { id: string, session: string, kind: string, label: string, phase: string,
    input_event: i64, through: i64, result_event: i64, recovery_event: i64 };
alias Schema = MemoryRegion<{ Counter: Store<string, i64>, Attempts: Store<string, Attempt> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-attempts-v1", store = "native-attempts");

public flow attempts(session: string, unresolved: bool) -> Array<Attempt> ![Memory, Error<StorageError>] {
    var result: Array<Attempt> = [];
    var cursor: Option<MemoryCursor> = None();
    while true limit Iterations(2147483647) {
        let page = Data.Attempts.page(cursor, 100);
        for item in page.entries limit Iterations(2147483647) {
            let value = item.value;
            if value.session == session && (!unresolved || (value.phase != "completed" && value.phase != "closed_unknown")) {
                result = result.push(value);
            }
        }
        match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
    }
    return result;
}

public flow turn_available(session: string) -> unit ![Memory, Error<StorageError>] {
    for value in attempts(session, true) limit Iterations(2147483647) {
        if value.kind == "coding" || value.kind == "summary" {
            abort("inference has no recorded completion: " + value.id + "; inspect /runs, then /resolve-run ID NOTE before starting a new turn");
        }
    }
}

public flow begin(session: string, kind: string, label: string, input_event: i64, through: i64) -> Attempt
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    if kind == "coding" || kind == "summary" { turn_available(session); }
    let before = get_entry(Data.Counter, "attempt");
    let number = match before { Some(value) => value.value, None() => 0 };
    match before {
        Some(value) => { Data.Counter.put_versioned("attempt", number + 1, value.version); }
        None() => { Data.Counter.insert("attempt", number + 1); }
    }
    let value = Attempt { id = session + "-run-" + from_i64(number), session = session, kind = kind, label = label,
        phase = "prepared", input_event = input_event, through = through, result_event = -1, recovery_event = -1 };
    Data.Attempts.insert(value.id, value);
    return value;
}

flow update(id: string, phase: string, result_event: i64, recovery_event: i64) -> Attempt {
    let before = match get_entry(Data.Attempts, id) { Some(value) => value, None() => { abort("native attempt not found"); } };
    let old = before.value;
    let value = Attempt { id = id, session = old.session, kind = old.kind, label = old.label, phase = phase,
        input_event = old.input_event, through = old.through, result_event = result_event, recovery_event = recovery_event };
    Data.Attempts.put_versioned(id, value, before.version);
    return value;
}

flow load(id: string) -> Attempt {
    return match Data.Attempts.get(id) { Some(value) => value, None() => { abort("native attempt not found"); } };
}

public flow dispatching(id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let value = load(id);
    if value.phase != "prepared" { abort("attempt dispatch has already been recorded"); }
    update(id, "dispatching", -1, -1);
}

public flow returned(id: string, role: string, name: string, text: string, call: i64) -> unit
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let value = load(id);
    if value.phase != "dispatching" { abort("attempt is not awaiting a result"); }
    let index = reserve_result(value.session, role, name, call);
    update(id, "returned", index, -1);
    complete_result(value.session, index, text);
}

public flow complete_attempt(id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let value = load(id);
    if value.phase == "completed" { return; }
    if value.result_event < 0 || !complete_event(value.session, value.result_event) { abort("attempt has no complete saved result"); }
    if value.kind == "summary" { adopt_summary(value.session, value.result_event, value.through); }
    if value.kind == "command" {
        let archive = NativeHistory {};
        let binding = value.session + ":" + from_i64(value.input_event) + " command";
        if archive.load(value.session).pending == binding {
            // tool_finished retains the already complete actual result.
            handle { tool_finished("command", value.input_event, "recorded result retained"); }
                with { SessionContext.current() => { resume value.session; } };
        }
    }
    update(id, "completed", value.result_event, value.recovery_event);
}

/// Called by the interactive user, never registered as a model tool. Closing
/// an unknown outcome does not manufacture a command result or replay work.
public flow resolve(session: string, id: string, note: string) -> Attempt
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let value = load(id);
    if value.session != session { abort("attempt belongs to another conversation"); }
    if value.phase == "completed" || value.phase == "closed_unknown" { return value; }
    if value.result_event >= 0 && complete_event(session, value.result_event) { complete_attempt(id); return load(id); }
    if note == "" { abort("record your inspection and recovery decision in NOTE; the outcome remains unknown"); }
    let archive = NativeHistory {};
    let statement = "User closed unresolved " + value.kind + " " + id + ". Outcome remains unknown; no execution, success, process termination or replay is inferred. Inspection/decision: " + note;
    let binding = session + ":" + from_i64(value.input_event) + " command";
    let recovery_event = if value.kind == "command" && archive.load(session).pending == binding {
        acknowledge_command(session, value.input_event, statement)
    }
    else { archive.append(session, "recovery", "attempt_outcome_unknown", statement, value.input_event) };
    return update(id, "closed_unknown", value.result_event, recovery_event);
}
