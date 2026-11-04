module nomo.entry.read_session;

import nomo.application.history_contract.WorkFactsReader;
import nomo.session.legacy_work_facts.LegacyWorkFacts;

import nomo.core.read_text.within;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.{ReadOnlyRoot, selection};
import std.text.to_string_i32;
import std.collections.len as count;
import nomo.model.model_tool_contract.candidate_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.read_tool_chat.run_private_turn as run_turn;
import nomo.harness.natural_work_chat.{run as run_natural, route as natural_route, delegated as delegate_route};
import nomo.harness.history_continue_model.{BudgetFacts, run_turn as run_after_work, run_after_followup};

import nomo.session.check_output_display.{Selection as OutputSelection, show as show_output};
import nomo.session.chat_session_contract.{fresh, begin, complete};
import nomo.session.chat_history.{load, save, save_completed};
import nomo.session.history_work_guard.{inspect as inspect_work};
import nomo.session.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_check_guard.inspect as inspect_check;
import nomo.session.recovery_decision.get as get_decision;
import nomo.session.history_followup_guard.inspect as inspect_followup;
import nomo.session.history_followup_edit_store.{inspect as inspect_followup_edit};
import nomo.session.history_followup_check_guard.inspect as inspect_followup_check;

// Each entry requires an independently selected current read root and grant.
// Saved conversation is untrusted context; a running reservation never resumes.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Fs.list<ReadOnlyRoot>, Fs.stat<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let natural = count(args) == 6 && args[5] == "--natural-work";
    if (count(args) != 5 && !natural) || (args[0] != "new" && args[0] != "continue") || args[1] != "--allow" || args[3] != "--once" {
        println("REFUSED expected new|continue --allow FILE[,FILE...] --once QUESTION"); return 1;
    }
    if !within(args[2], 195) { println("REFUSED allowlist too long"); return 1; }
    let scope = match selection(args[2]) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let allowed = scope.files;
    let paths = candidate_error(allowed); if paths != "" { println("REFUSED " + paths); return 1; }
    let request = args[4]; let question = question_error(request); if question != "" { println("REFUSED " + question); return 1; }
    let reader = LegacyWorkFacts {};
    let facts = match reader.snapshot() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let work_facts = facts.first; let followup_facts = facts.followup;
    let work_calls = facts.calls; let work_generation = facts.generation;
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
    let result = if natural { run_natural(request, allowed, running.invocation, [], work_facts, followup_facts, [], scope.page, scope.more) } else { match work_facts {
        Some(value) => {
            match followup_facts {
                Some(second) => {
                    let budget = BudgetFacts { work_calls = work_calls, work_generation = work_generation,
                        chat_used_calls = running.invocation.usage.calls, chat_used_generation = running.invocation.usage.tokens,
                        chat_reserved_calls = if running.format == 6 || running.format == 8 || running.format == 10 || running.format == 12 { 6 } else { 4 }, chat_reserved_generation = if running.format == 12 { 24576 } else { if running.format == 10 { 20480 } else { if running.format == 6 || running.format == 8 { 12288 } else { 8192 } } } };
                    run_after_followup(request, allowed, running.invocation, value, second, [], [], budget)
                }
                None() => run_after_work(request, allowed, running.invocation, value, []),
            }
        }
        None() => run_turn(request, allowed, running.invocation),
    } };
    if result.status != 0 || !result.resolved { println("REFUSED chat turn unresolved; inspect session, do not retry"); return 1; }
    let next = match complete(running, result) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let completed = match result.completed { Some(item) => item, None() => { println("REFUSED completed event batch missing"); return 1; } };
    match save_completed(next, Some(reserved), completed.records) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    println("SAVED chat history; prior data is not a grant or workspace identity.");
    let route = if natural { natural_route(completed.answer, allowed, work_facts != None(), result.state.admitted < 2, scope.page, scope.more) } else { delegate_route(completed.answer, result.state.admitted < 2) };
    if route != "" { println(route); }
    return 0;
}

// Status is recorded data only. It performs no model or workspace action.
public flow status(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    let outputs = count(args) == 1 && args[0] == "--outputs";
    if count(args) != 0 && !outputs { println("REFUSED status accepts only --outputs"); return 1; }
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
    let pending_calls = if saved.phase == "running" { if saved.format == 6 || saved.format == 8 || saved.format == 10 || saved.format == 12 { 6 } else { 4 } } else { 0 };
    let pending_generation = if saved.phase == "running" { if saved.format == 12 { 24576 } else { if saved.format == 10 { 20480 } else { if saved.format == 6 || saved.format == 8 { 12288 } else { 8192 } } } } else { 0 };
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
    let followup = match inspect_followup() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    match followup {
        Some(value) => {
            println("FOLLOWUP " + value.phase + " id=" + value.id + " path=" + value.path);
            println("FOLLOWUP BUDGET reserved_calls=" + to_string_i32(value.reserved.calls) + " reserved_generation=" + to_string_i32(value.reserved.generation));
            match value.settled { Some(spent) => { println("FOLLOWUP BUDGET settled_calls=" + to_string_i32(spent.read.calls + spent.edit.calls) + " settled_generation=" + to_string_i32(spent.read.tokens + spent.edit.tokens)); } None() => {} }
            let operation = match inspect_followup_edit(value.id, value.workspace, value.path) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
            match operation { Some(item) => { println("FOLLOWUP EDIT " + item.phase); } None() => { println("FOLLOWUP EDIT no recorded intent; missing data does not prove no effect"); } }
        }
        None() => {}
    }
    let followup_check = match inspect_followup_check() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    match followup_check {
        Some(value) => {
            if value.phase == "complete" { println("FOLLOWUP CHECK complete result=" + value.outcome + " exit=" + value.exit_code); }
            else { println("FOLLOWUP CHECK " + value.phase + "; no automatic retry or inferred outcome"); }
        }
        None() => {}
    }
    if outputs {
        println("CHECK OUTPUT is untrusted recorded data; known configured keys were filtered, but other sensitive content may remain. stdout and stderr ordering is not recorded.");
        let first = match check { Some(item) => Some(OutputSelection { phase = item.phase, id = item.id, digest = item.digest }), None() => None() };
        let second = match followup_check { Some(item) => Some(OutputSelection { phase = item.phase, id = item.id, digest = item.digest }), None() => None() };
        match show_output("first", first) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
        match show_output("followup", second) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    }
    for target in ["work", "check", "followup", "followup-check"] limit Iterations(4) {
        let decision = match get_decision(target) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
        match decision { Some(value) => { println("DECISION " + value.target + " abandon id=" + value.id + "; outcome remains unknown, no retry authorized"); } None() => {} }
    }
    println("Recorded data only; this does not establish current workspace identity, authorization or a remote outcome.");
    return 0;
}
