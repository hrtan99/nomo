module nomo.entry.read_session;

import nomo.application.history_contract.WorkFactsReader;
import nomo.application.status_contract.SessionStatusReader;
import nomo.application.chat.controller.{open as open_chat, reserve_loaded as reserve_chat, finish as finish_chat};
import nomo.bootstrap.chat.{LegacyChatRepository, legacy_repository};
import nomo.bootstrap.legacy_status.legacy_status_reader;
import nomo.session.chat_history.Entry as LegacyChatTicket;
import nomo.session.legacy_work_facts.LegacyWorkFacts;

import nomo.core.read_text.within;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.{ReadOnlyRoot, selection};
import std.text.from_i32;
import std.collections.len as count;
import nomo.model.model_tool_contract.candidate_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.read_tool_chat.run_private_turn as run_turn;
import nomo.harness.natural_work_chat.{run as run_natural, route as natural_route, delegated as delegate_route};
import nomo.harness.history_continue_model.{BudgetFacts, run_turn as run_after_work, run_after_followup};

import nomo.session.check_output_display.{Selection as OutputSelection, show as show_output};
import nomo.session.chat_format_policy.policy as format_policy;

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
    let repository = legacy_repository();
    let current = match open_chat<LegacyChatTicket, LegacyChatRepository>(repository, args[0] == "new") {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; }
    };
    let reservation = match reserve_chat<LegacyChatTicket, LegacyChatRepository>(repository, current, request) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; }
    };
    let reserved = reservation.reserved; let running = reserved.value;
    println("RESERVED chat turn; interruption leaves it unresolved and will not retry.");
    println("A final answer is provisional until SAVED confirms durable history.");
    let result = if natural { run_natural(request, allowed, running.invocation, [], work_facts, followup_facts, [], scope.page, scope.more) } else { match work_facts {
        Some(value) => {
            match followup_facts {
                Some(second) => {
                    let reservation = format_policy(running.format).pending_reservation(running.phase);
                    let budget = BudgetFacts { work_calls = work_calls, work_generation = work_generation,
                        chat_used_calls = running.invocation.usage.calls, chat_used_generation = running.invocation.usage.tokens,
                        chat_reserved_calls = reservation.calls, chat_reserved_generation = reservation.generation };
                    run_after_followup(request, allowed, running.invocation, value, second, [], [], budget)
                }
                None() => run_after_work(request, allowed, running.invocation, value, []),
            }
        }
        None() => run_turn(request, allowed, running.invocation),
    } };
    match finish_chat<LegacyChatTicket, LegacyChatRepository>(repository, reserved, result) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    let completed = match result.completed { Some(item) => item, None() => { println("REFUSED completed event batch missing"); return 1; } };
    println("SAVED chat history; prior data is not a grant or workspace identity.");
    let can_continue = format_policy(running.format).continuation_rule(result.state.admitted);
    let route = if natural { natural_route(completed.answer, allowed, work_facts != None(), can_continue, scope.page, scope.more) } else { delegate_route(completed.answer, can_continue) };
    if route != "" { println(route); }
    return 0;
}

// Status is recorded data only. It performs no model or workspace action.
public flow status(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    let outputs = count(args) == 1 && args[0] == "--outputs";
    if count(args) != 0 && !outputs { println("REFUSED status accepts only --outputs"); return 1; }
    let snapshot = match legacy_status_reader().snapshot() { Ok(value) => value, Err(error) => {
        if error == "SESSION missing" { println(error); } else { println("REFUSED " + error); } return 1;
    } };
    let entry = snapshot.chat;
    let saved = entry.value;
    println("SESSION " + saved.phase + " turns=" + from_i32(saved.invocation.admitted));
    if entry.schema == 1 { println("EVENTS unavailable for legacy history"); }
    else {
        if entry.pending { println("EVENTS pending; chat turn not committed, do not retry"); }
        else if entry.schema == 2 { println("EVENTS recorded turns=" + from_i32(saved.invocation.admitted) + "; free text redacted"); }
        else { println("EVENTS recorded turns=" + from_i32(saved.invocation.admitted) + "; free text redacted, atomically stored with chat"); }
        for event in entry.events limit Iterations(48) { println("EVENT " + event.role + " " + event.kind + " " + event.name + " " + event.text); }
    }
    let reservation = format_policy(saved.format).pending_reservation(saved.phase);
    let pending_calls = reservation.calls; let pending_generation = reservation.generation;
    println("CHAT BUDGET used_calls=" + from_i32(saved.invocation.usage.calls) + " used_generation=" +
        from_i32(saved.invocation.usage.tokens) + " reserved_calls=" + from_i32(pending_calls) +
        " reserved_generation=" + from_i32(pending_generation));
    let work = snapshot.work;
    match work {
        Some(value) => {
            println("WORK " + value.phase + " id=" + value.id + " path=" + value.path);
            println("WORK BUDGET reserved_calls=" + from_i32(value.reserved.calls) + " reserved_generation=" + from_i32(value.reserved.generation));
            match value.settled { Some(spent) => { println("WORK BUDGET settled_calls=" + from_i32(spent.read.calls + spent.edit.calls) +
                " settled_generation=" + from_i32(spent.read.tokens + spent.edit.tokens)); } None() => {} }
            match snapshot.work_edit { Some(item) => { println("EDIT " + item.phase); } None() => { println("EDIT no recorded intent; missing data does not prove no effect"); } }
        }
        None() => {}
    }
    let check = snapshot.check;
    match check {
        Some(value) => {
            if value.phase == "complete" { println("CHECK complete result=" + value.outcome + " exit=" + value.exit_code); }
            else { println("CHECK " + value.phase + "; no automatic retry or inferred outcome"); }
        }
        None() => {}
    }
    let followup = snapshot.followup;
    match followup {
        Some(value) => {
            println("FOLLOWUP " + value.phase + " id=" + value.id + " path=" + value.path);
            println("FOLLOWUP BUDGET reserved_calls=" + from_i32(value.reserved.calls) + " reserved_generation=" + from_i32(value.reserved.generation));
            match value.settled { Some(spent) => { println("FOLLOWUP BUDGET settled_calls=" + from_i32(spent.read.calls + spent.edit.calls) + " settled_generation=" + from_i32(spent.read.tokens + spent.edit.tokens)); } None() => {} }
            match snapshot.followup_edit { Some(item) => { println("FOLLOWUP EDIT " + item.phase); } None() => { println("FOLLOWUP EDIT no recorded intent; missing data does not prove no effect"); } }
        }
        None() => {}
    }
    let followup_check = snapshot.followup_check;
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
    for value in snapshot.decisions limit Iterations(4) { println("DECISION " + value.target + " abandon id=" + value.id + "; outcome remains unknown, no retry authorized"); }
    println("Recorded data only; this does not establish current workspace identity, authorization or a remote outcome.");
    return 0;
}
