module nomo.entry.read_session;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import std.text.{len, split, to_string_i32};
import std.collections.len as count;
import nomo.model.model_tool_contract.allowed_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.read_tool_chat.run_turn;
import nomo.harness.history_continue_model.{WorkFacts, run_turn as run_after_work};
import nomo.session.chat_session_contract.{fresh, begin, complete};
import nomo.session.chat_history.{load, save, save_completed};
import nomo.session.history_work_guard.{chat_available, inspect as inspect_work};
import nomo.session.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_check_guard.inspect as inspect_check;
import nomo.session.recovery_decision.get as get_decision;

// Each entry requires an independently selected current read root and grant.
// Saved conversation is untrusted context; a running reservation never resumes.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) != 5 || (args[0] != "new" && args[0] != "continue") || args[1] != "--allow" || args[3] != "--once" {
        println("REFUSED expected new|continue --allow FILE[,FILE] --once QUESTION"); return 1;
    }
    if len(args[2]) > 97 { println("REFUSED allowlist too long"); return 1; }
    let allowed = split(args[2], ",");
    let paths = allowed_error(allowed); if paths != "" { println("REFUSED " + paths); return 1; }
    let request = args[4]; let question = question_error(request); if question != "" { println("REFUSED " + question); return 1; }
    let past_work = match inspect_work() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    var work_facts: Option<WorkFacts> = None();
    match past_work {
        None() => { match chat_available() { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } } }
        Some(work) => {
            if work.phase != "complete" { println("REFUSED work is not complete; inspect before continuing"); return 1; }
            let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { println("REFUSED completed edit record required"); return 1; } };
            if edit.phase != "completed" { println("REFUSED edit outcome unresolved"); return 1; }
            let check = match inspect_check() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
            var outcome = "not requested"; var exit = "";
            match check {
                Some(value) => { if value.id != work.id { println("REFUSED check work identity differs"); return 1; } if value.phase != "complete" { println("REFUSED check outcome unresolved"); return 1; } outcome = value.outcome; exit = value.exit_code; }
                None() => {}
            }
            work_facts = Some(WorkFacts { id = work.id, summary = work.summary, check = outcome, exit_code = exit });
        }
    }
    let existing = match load() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    if args[0] == "new" {
        match existing { Some(_) => { println("REFUSED session already exists"); return 1; } None() => {} }
        match save(fresh(), None()) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    } else {
        match existing { None() => { println("REFUSED session missing"); return 1; } Some(_) => {} }
    }
    let current = match load() { Ok(Some(value)) => value, _ => { println("REFUSED session missing or invalid"); return 1; } };
    if current.pending { println("REFUSED event history pending; inspect without retry"); return 1; }
    let running = match begin(current.value, request) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let version = match save(running, Some(current)) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let reserved = match load() { Ok(Some(value)) => value, _ => { println("REFUSED reservation missing"); return 1; } };
    if reserved.value != running || reserved.version.opaque != version.opaque { println("REFUSED reservation changed"); return 1; }
    println("RESERVED chat turn; interruption leaves it unresolved and will not retry.");
    println("A final answer is provisional until SAVED confirms durable history.");
    let result = match work_facts {
        Some(value) => run_after_work(request, allowed, running.invocation, value),
        None() => run_turn(request, allowed, running.invocation),
    };
    if result.status != 0 || !result.resolved { println("REFUSED chat turn unresolved; inspect session, do not retry"); return 1; }
    let next = match complete(running, result) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let completed = match result.completed { Some(item) => item, None() => { println("REFUSED completed event batch missing"); return 1; } };
    match save_completed(next, Some(reserved), completed.records) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    println("SAVED chat history; prior data is not a grant or workspace identity."); return 0;
}

// Status is recorded data only. It performs no model or workspace action.
public flow status(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    if count(args) != 0 { println("REFUSED status takes no arguments"); return 1; }
    let entry = match load() { Ok(Some(value)) => value, Ok(None()) => { println("SESSION missing"); return 1; } Err(error) => { println("REFUSED " + error); return 1; } };
    let saved = entry.value;
    println("SESSION " + saved.phase + " turns=" + to_string_i32(saved.invocation.admitted));
    if entry.schema == 1 { println("EVENTS unavailable for legacy history"); }
    else {
        if entry.pending { println("EVENTS pending; chat turn not committed, do not retry"); }
        else if entry.schema == 2 { println("EVENTS recorded turns=" + to_string_i32(saved.invocation.admitted) + "; free text redacted"); }
        else { println("EVENTS recorded turns=" + to_string_i32(saved.invocation.admitted) + "; free text redacted, atomically stored with chat"); }
        for event in entry.events limit Iterations(48) { println("EVENT " + event.role + " " + event.kind + " " + event.name + " " + event.text); }
    }
    let pending_calls = if saved.phase == "running" { 4 } else { 0 };
    let pending_generation = if saved.phase == "running" { 8192 } else { 0 };
    println("CHAT BUDGET used_calls=" + to_string_i32(saved.invocation.usage.calls) + " used_generation=" +
        to_string_i32(saved.invocation.usage.tokens) + " reserved_calls=" + to_string_i32(pending_calls) +
        " reserved_generation=" + to_string_i32(pending_generation));
    let work = match inspect_work() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    match work {
        Some(value) => {
            println("WORK " + value.phase + " id=" + value.id + " path=" + value.path);
            println("WORK BUDGET reserved_calls=" + to_string_i32(value.reserved.calls) + " reserved_generation=" + to_string_i32(value.reserved.generation));
            match value.settled { Some(spent) => { println("WORK BUDGET settled_calls=" + to_string_i32(spent.read.calls + spent.edit.calls) +
                " settled_generation=" + to_string_i32(spent.read.tokens + spent.edit.tokens)); } None() => {} }
            let operation = match inspect_edit(value.id, value.workspace, value.path) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
            match operation { Some(item) => { println("EDIT " + item.phase); } None() => { println("EDIT no recorded intent; missing data does not prove no effect"); } }
        }
        None() => {}
    }
    let check = match inspect_check() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    match check {
        Some(value) => {
            if value.phase == "complete" { println("CHECK complete result=" + value.outcome + " exit=" + value.exit_code); }
            else { println("CHECK " + value.phase + "; no automatic retry or inferred outcome"); }
        }
        None() => {}
    }
    for target in ["work", "check"] limit Iterations(2) {
        let decision = match get_decision(target) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
        match decision { Some(value) => { println("DECISION " + value.target + " abandon id=" + value.id + "; outcome remains unknown, no retry authorized"); } None() => {} }
    }
    println("Recorded data only; this does not establish current workspace identity, authorization or a remote outcome.");
    return 0;
}
