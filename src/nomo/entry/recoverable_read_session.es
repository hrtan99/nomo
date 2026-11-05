module nomo.entry.recoverable_read_session;

import nomo.core.read_text.within;
import nomo.application.chat.controller.{open as open_chat, reserve_loaded as reserve_chat, finish as finish_chat};
import nomo.application.status_contract.SessionStatusReader;
import nomo.bootstrap.chat.{RecoverableTicket, RecoverableChatRepository, recoverable_repository};
import nomo.bootstrap.recoverable_status.recoverable_status_reader;
import std.io.println;
import std.text.{ends_with, from_i32};
import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import std.collections.len as count;
import nomo.model.model_tool_contract.candidate_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.read_tool_chat.{run_private_turn, run_with_history};
import nomo.harness.natural_work_chat.{run as run_natural, route as natural_route, delegated as delegate_route};
import nomo.harness.history_continue_model.{BudgetFacts, run_turn as run_after_work, run_after_followup};
import nomo.session.recoverable_work_facts.snapshot as work_facts;
import nomo.session.continuous_work.Entry as ExtraEntry;
import nomo.session.event_policy.load as load_policy;
import nomo.session.event_text_codec.decode;
import nomo.session.redaction.Policy;
import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.session.chat_history.load as load_legacy;
import nomo.session.recoverable_chat_store.{create, load, load_evidence, chat_omitted};
import nomo.session.history_work_guard.inspect as inspect_work;
import nomo.session.history_followup_guard.inspect as inspect_followup;
import nomo.session.history_check_guard.inspect as inspect_check;
import nomo.session.history_followup_check_guard.inspect as inspect_followup_check;
import nomo.session.edit_operation_store.inspect as inspect_first_edit;
import nomo.session.history_followup_edit_store.inspect as inspect_second_edit;
import nomo.session.edit_operation.Record as EditRecord;
import nomo.session.session_display.ascii_json_with;
import nomo.core.conversation.Event;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.{ReadOnlyRoot, selection};
import nomo.session.event_policy.PolicyRoot;
import nomo.session.chat_format_policy.policy as format_policy;

// Explicit opt-in path. It does not silently migrate v1-v3, establish a
// workspace identity, or claim comprehensive secret redaction.
flow conversation(frame: EventFrame, policy: Policy, binding: string) -> Result<Array<Event>, string> {
    var selected: Array<Event> = []; var chat_turn: i32 = 0;
    for event in frame.events limit Iterations(4096) {
        if event.role == "system" && event.kind == "native-budget" && (event.name == "chat" || event.name == "chat-large" || event.name == "chat-resilient" || event.name == "chat-high-input") {
            chat_turn = chat_turn + 1;
        }
        if (event.role == "user" && event.kind == "request") ||
            (event.role == "model" && event.kind == "request") ||
            (event.role == "tool" && event.kind == "check") ||
            (event.role == "system" && (event.kind == "work-boundary" || event.kind == "notice")) ||
            (event.role == "assistant" && event.kind == "answer") ||
            (event.role == "main" && (event.kind == "consume" || event.kind == "tool" || event.kind == "answer")) {
            var value = match decode(event.text, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
            if event.role == "main" && event.kind == "tool" && value == chat_omitted() && chat_turn < frame.turns {
                value = match load_evidence(chat_turn, policy, binding) {
                    Ok(Some(item)) => item,
                    Ok(None()) => { return Err("archived recoverable chat evidence missing"); }
                    Err(error) => { return Err(error); }
                };
            }
            selected = selected.push(Event { role = event.role, kind = event.kind, name = event.name, text = value });
        }
    }
    return Ok(selected);
}
public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Fs.list<ReadOnlyRoot>, Fs.stat<ReadOnlyRoot>, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let size = count(args);
    let natural = (size >= 8 && args[7] == "--natural-work") || (size == 9 && args[8] == "--natural-work");
    let high_input = (size >= 8 && args[7] == "--high-input") || (size == 9 && args[8] == "--high-input");
    let flags_ok = size == 7 || (size == 8 && (natural || high_input)) || (size == 9 && natural && high_input && args[7] != args[8]);
    if !flags_ok || (args[0] != "new" && args[0] != "continue") || (high_input && args[0] != "new") || args[1] != "--allow" || args[3] != "--once" || args[5] != "--policy-binding" {
        println("REFUSED expected new|continue --allow FILE[,FILE...] --once QUESTION"); return 1;
    }
    if !within(args[2], 195) { println("REFUSED allowlist too long"); return 1; }
    let scope = match selection(args[2]) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let allowed = scope.files;
    let invalid = candidate_error(allowed);
    if invalid != "" || question_error(args[4]) != "" { println("REFUSED invalid read request"); return 1; }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    match load_legacy() { Ok(None()) => {} Ok(Some(_)) => { println("REFUSED legacy session cannot be migrated automatically"); return 1; } Err(error) => { println("REFUSED " + error); return 1; } }
    match inspect_work() { Ok(None()) => {} _ => { println("REFUSED work record exists or is invalid"); return 1; } }
    match inspect_followup() { Ok(None()) => {} _ => { println("REFUSED followup record exists or is invalid"); return 1; } }
    match inspect_check() { Ok(None()) => {} _ => { println("REFUSED check record exists or is invalid"); return 1; } }
    match inspect_followup_check() { Ok(None()) => {} _ => { println("REFUSED followup check exists or is invalid"); return 1; } }
    let binding = args[6];
    let repository = recoverable_repository(policy, binding, high_input);
    let current = match open_chat<RecoverableTicket, RecoverableChatRepository>(repository, args[0] == "new") { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let facts = match work_facts(policy, binding) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let history = match conversation(current.value.events, policy, binding) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let reservation = match reserve_chat<RecoverableTicket, RecoverableChatRepository>(repository, current, args[4]) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let running = reservation.reserved;
    println("RESERVED chat turn; interruption leaves it unresolved and will not retry.");
    println("A final answer is provisional until SAVED confirms durable history.");
    let result = if natural { run_natural(args[4], allowed, running.value.chat.invocation, history, facts.first, facts.followup, facts.additional, scope.page, scope.more) } else { match facts.first {
        Some(first) => { match facts.followup {
            Some(second) => {
                let usage = running.value.chat.invocation.usage; let pending = format_policy(running.value.chat.format).pending_reservation(running.value.chat.phase);
                let budget = BudgetFacts { work_calls = facts.calls, work_generation = facts.generation, chat_used_calls = usage.calls, chat_used_generation = usage.tokens,
                    chat_reserved_calls = pending.calls, chat_reserved_generation = pending.generation };
                run_after_followup(args[4], allowed, running.value.chat.invocation, first, second, facts.additional, history, budget)
            }
            None() => run_after_work(args[4], allowed, running.value.chat.invocation, first, history),
        } }
        None() => if format_policy(running.value.chat.format).history_rule(running.value.chat.invocation.admitted, current.value.events.format) { run_with_history(args[4], allowed, running.value.chat.invocation, history) }
            else { run_private_turn(args[4], allowed, running.value.chat.invocation) },
    } };
    match finish_chat<RecoverableTicket, RecoverableChatRepository>(repository, running, result) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    println("SAVED chat and event records together; saved text is untrusted and does not grant authority.");
    match result.completed { Some(item) => { let can_continue = format_policy(running.value.chat.format).continuation_rule(result.state.admitted); let route = if natural { natural_route(item.answer, allowed, facts.first != None(), can_continue, scope.page, scope.more) } else { delegate_route(item.answer, can_continue) }; if route != "" { println(route); } } None() => {} }
    return 0;
}

flow edit_phase(result: Result<Option<EditRecord>, string>) -> string {
    return match result { Ok(Some(item)) => item.phase, Ok(None()) => "none", Err(_) => "unknown" };
}
flow show_edit_status(label: string, phase: string) -> unit {
    if phase == "completed" { println("UNRESOLVED " + label + ": edit completion was recorded; inspect the current file, which may have changed since."); }
    else if phase == "intent" { println("UNRESOLVED " + label + ": edit intent was recorded but its outcome is unknown; inspect the file."); }
    else if phase == "none" { println("UNRESOLVED " + label + ": no edit journal is recorded; the earlier process may still act."); }
    else { println("UNRESOLVED " + label + ": edit record is unavailable or changed; inspect the file."); }
}

public type View = { format: i32, encoding: string, phase: string, turns: i32, first_count: usize,
    used_calls: i32, used_tokens: i32, used_tools: i32, used_scan: i32, reserved_calls: i32, reserved_tokens: i32,
    events: Array<Event>, work_phase: string, work_edit_phase: string, work_reserved_calls: i32, work_reserved_tokens: i32,
    work_settled_calls: i32, work_settled_tokens: i32, work_events: Array<Event>,
    check_phase: string, check_id: string, check_digest: string, check_outcome: string, check_exit: string,
    check_stdout: string, check_stderr: string, check_stdout_truncated: bool, check_stderr_truncated: bool, check_stdout_omitted: bool, check_stderr_omitted: bool,
    followup_phase: string, followup_edit_phase: string, followup_reserved_calls: i32, followup_reserved_tokens: i32, followup_settled_calls: i32, followup_settled_tokens: i32, followup_events: Array<Event>,
    followup_check_phase: string, followup_check_id: string, followup_check_digest: string, followup_check_outcome: string, followup_check_exit: string,
    followup_check_stdout: string, followup_check_stderr: string, followup_check_stdout_truncated: bool, followup_check_stderr_truncated: bool, followup_check_stdout_omitted: bool, followup_check_stderr_omitted: bool,
    additional_work: Array<ExtraEntry> };

public flow status(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let initialize = count(args) == 3 && args[2] == "--initialize";
    if (count(args) != 2 && !initialize) || args[0] != "--policy-binding" { println("REFUSED recoverable status requires policy binding"); return 1; }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    match load_legacy() { Ok(None()) => {} _ => { println("REFUSED legacy or invalid session data"); return 1; } }
    if initialize {
        match load(policy, args[1]) { Ok(None()) => {} Ok(Some(_)) => { println("REFUSED session already exists"); return 1; } Err(error) => { println("REFUSED " + error); return 1; } }
        return match create(policy, args[1], false) { Ok(_) => { println("SESSION INITIALIZED"); 0 } Err(error) => { println("REFUSED " + error); 1 } };
    }
    let snapshot = match recoverable_status_reader(policy, args[1]).snapshot() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let saved = snapshot.chat; let work = snapshot.work; let check = snapshot.check;
    let followup = snapshot.followup; let followup_check = snapshot.followup_check; let extra = snapshot.additional;
    var additional: Array<ExtraEntry> = [];
    match extra { Some(item) => { additional = item.value.history.push(item.value.current); } None() => {} }
    var chat_reservations: i32 = 0; var native_configured: i32 = 0; var legacy_native_unknown = false;
    for event in saved.value.events.events limit Iterations(4096) { if event.role == "system" && event.kind == "native-budget" && (event.name == "chat" || event.name == "chat-large" || event.name == "chat-resilient" || event.name == "chat-high-input") { chat_reservations = chat_reservations + 1; native_configured = native_configured + if event.name == "chat-resilient" || event.name == "chat-high-input" { 3786432 } else { if event.name == "chat-large" { 3048576 } else { 1179648 } }; } }
    let completed_new = if saved.value.chat.phase == "running" && chat_reservations > 0 { chat_reservations - 1 } else { chat_reservations };
    if saved.value.chat.invocation.admitted > completed_new { legacy_native_unknown = true; }
    match work { Some(item) => { if item.value.work.format >= 4 { native_configured = native_configured + if item.value.work.format == 7 || item.value.work.format == 8 { 2811008 } else { if item.value.work.format == 6 { 2073152 } else { 1335296 } }; } else { legacy_native_unknown = true; } } None() => {} }
    match followup { Some(item) => { if item.value.work.format >= 4 { native_configured = native_configured + if item.value.work.format == 7 || item.value.work.format == 8 { 2811008 } else { if item.value.work.format == 6 { 2073152 } else { 1335296 } }; } else { legacy_native_unknown = true; } } None() => {} }
    for item in additional limit Iterations(48) { if ends_with(item.result.source, "-v5") || ends_with(item.result.source, "-v4") { native_configured = native_configured + 2811008; } else { if ends_with(item.result.source, "-v3") { native_configured = native_configured + 2073152; } else { if item.result.source == "v2" || ends_with(item.result.source, "-v2") { native_configured = native_configured + 1335296; } else { legacy_native_unknown = true; } } } }
    println("NATIVE configured cumulative reservation=" + from_i32(native_configured) + "; actual provider usage unknown; legacy native budget " + if legacy_native_unknown { "unknown" } else { "not present" });
    for item in additional limit Iterations(48) {
        println("ADDITIONAL WORK " + item.core.id + " phase=" + item.result.phase + " edit=" + item.edit.phase + " check=" + item.check.phase +
            " settled_calls=" + from_i32(item.result.calls) + " settled_generation=" + from_i32(item.result.generation) +
            if item.result.phase == "running" || item.result.phase == "abandoned" { if item.result.source == "wide-v5" || item.result.source == "wide-v4" { " reserved_calls=7 reserved_generation=286720" } else { if item.result.source == "wide-v3" { " reserved_calls=7 reserved_generation=188416" } else { if item.result.source == "wide" || item.result.source == "wide-v2" { " reserved_calls=7 reserved_generation=61440" } else { " reserved_calls=7 reserved_generation=51200" } } } } else { " reserved_calls=0 reserved_generation=0" });
        if item.check.phase == "abandoned" { println("ABANDONED CHECK: outcome unknown; inspect the workspace before further action."); }
    }
    var followup_phase = "none"; var followup_edit_phase = "none"; var followup_reserved_calls: i32 = 0; var followup_reserved_tokens: i32 = 0;
    var followup_settled_calls: i32 = 0; var followup_settled_tokens: i32 = 0; var followup_events: Array<Event> = [];
    match followup { Some(item) => {
        followup_phase = item.value.work.phase; followup_reserved_calls = item.value.work.reserved.calls; followup_reserved_tokens = item.value.work.reserved.generation;
        let selected = item.value.work;
        followup_edit_phase = edit_phase(inspect_second_edit(selected.id, selected.workspace, selected.path));
        followup_events = item.value.events.events;
        match item.value.work.settled { Some(spent) => { followup_settled_calls = spent.read.calls + spent.edit.calls; followup_settled_tokens = spent.read.tokens + spent.edit.tokens; } None() => {} }
        println("RECORDED FOLLOWUP " + followup_phase + "; selected facts only, no replay or root identity implied.");
    } None() => {} }
    var followup_check_phase = "none"; var followup_check_id = ""; var followup_check_digest = ""; var followup_check_outcome = ""; var followup_check_exit = "";
    var followup_check_stdout = ""; var followup_check_stderr = ""; var followup_check_stdout_truncated = false; var followup_check_stderr_truncated = false; var followup_check_stdout_omitted = false; var followup_check_stderr_omitted = false;
    match followup_check { Some(item) => {
        followup_check_phase = item.value.check.phase; followup_check_id = item.value.check.id; followup_check_digest = item.value.check.digest;
        followup_check_outcome = item.value.check.outcome; followup_check_exit = item.value.check.exit_code;
        followup_check_stdout = item.value.stdout; followup_check_stderr = item.value.stderr;
        followup_check_stdout_truncated = item.value.stdout_truncated; followup_check_stderr_truncated = item.value.stderr_truncated;
        followup_check_stdout_omitted = followup_check_stdout_truncated && followup_check_stdout == "\"\""; followup_check_stderr_omitted = followup_check_stderr_truncated && followup_check_stderr == "\"\"";
        if followup_check_stdout_omitted || followup_check_stderr_omitted { println("FOLLOWUP CHECK OUTPUT omitted because capture or transfer limits were exceeded; inspect or rerun only under a new explicitly authorized operation."); }
        println("RECORDED FOLLOWUP CHECK " + followup_check_phase + "; an interrupted check is not replayed.");
    } None() => {} }
    var check_phase = "none"; var check_id = ""; var check_digest = ""; var check_outcome = ""; var check_exit = "";
    var check_stdout = ""; var check_stderr = ""; var check_stdout_truncated = false; var check_stderr_truncated = false; var check_stdout_omitted = false; var check_stderr_omitted = false;
    match check { Some(item) => {
        check_phase = item.value.check.phase; check_id = item.value.check.id; check_digest = item.value.check.digest;
        check_outcome = item.value.check.outcome; check_exit = item.value.check.exit_code;
        check_stdout = item.value.stdout; check_stderr = item.value.stderr;
        check_stdout_truncated = item.value.stdout_truncated; check_stderr_truncated = item.value.stderr_truncated;
        check_stdout_omitted = check_stdout_truncated && check_stdout == "\"\""; check_stderr_omitted = check_stderr_truncated && check_stderr == "\"\"";
        if check_stdout_omitted || check_stderr_omitted { println("CHECK OUTPUT omitted because capture or transfer limits were exceeded; inspect or rerun only under a new explicitly authorized operation."); }
        println("RECORDED CHECK " + check_phase + "; an interrupted check is not replayed.");
    } None() => {} }
    var work_phase = "none"; var work_edit_phase = "none"; var work_reserved_calls: i32 = 0; var work_reserved_tokens: i32 = 0;
    var work_settled_calls: i32 = 0; var work_settled_tokens: i32 = 0; var work_events: Array<Event> = [];
    match work {
        Some(item) => {
            work_phase = item.value.work.phase; work_reserved_calls = item.value.work.reserved.calls;
            let selected = item.value.work;
            work_edit_phase = edit_phase(inspect_first_edit(selected.id, selected.workspace, selected.path));
            work_reserved_tokens = item.value.work.reserved.generation; work_events = item.value.events.events;
            match item.value.work.settled {
                Some(spent) => { work_settled_calls = spent.read.calls + spent.edit.calls; work_settled_tokens = spent.read.tokens + spent.edit.tokens; }
                None() => {}
            }
            println("RECORDED WORK " + work_phase + "; selected facts only, no replay or root identity implied.");
        }
        None() => {}
    }
    let used = saved.value.chat.invocation.usage;
    let pending = saved.value.chat.phase == "running";
    if pending { println("UNRESOLVED CHAT: the turn was reserved; its outcome and process termination are not established. Do not repeat it."); }
    if work_phase == "running" { show_edit_status("WORK", work_edit_phase); }
    if work_phase == "abandoned" { println("ABANDONED WORK: user chose to continue; the prior effect remains unknown and its full reservation is retained."); }
    if followup_phase == "running" { show_edit_status("FOLLOWUP", followup_edit_phase); }
    if check_phase == "abandoned" || followup_check_phase == "abandoned" { println("ABANDONED CHECK: outcome unknown; inspect the workspace before further action."); }
    if check_phase == "planned" { println("UNRESOLVED CHECK: no start was recorded at this snapshot; the earlier process may still act. Do not rerun automatically."); }
    else if check_phase == "running" { println("UNRESOLVED CHECK: start was recorded but completion is unknown. Do not rerun automatically."); }
    if followup_check_phase == "planned" { println("UNRESOLVED FOLLOWUP CHECK: no start was recorded at this snapshot; the earlier process may still act. Do not rerun automatically."); }
    else if followup_check_phase == "running" { println("UNRESOLVED FOLLOWUP CHECK: start was recorded but completion is unknown. Do not rerun automatically."); }
    if pending || work_phase == "running" || followup_phase == "running" || check_phase == "planned" || check_phase == "running" || followup_check_phase == "planned" || followup_check_phase == "running" {
        println("Before starting a separate session, ensure the earlier invocation has stopped and inspect the workspace. Use session-chat --new or session-id start with selected roots; a new session does not resolve this one and requires fresh approval.");
    }
    let pending_budget = format_policy(saved.value.chat.format).pending_reservation(saved.value.chat.phase);
    let view = View { format = 1, encoding = saved.value.encoding, phase = saved.value.chat.phase,
        turns = saved.value.events.turns, first_count = saved.value.events.first_count,
        used_calls = used.calls, used_tokens = used.tokens, used_tools = used.tools, used_scan = used.scan,
        reserved_calls = pending_budget.calls, reserved_tokens = pending_budget.generation,
        events = saved.value.events.events, work_phase = work_phase, work_edit_phase = work_edit_phase, work_reserved_calls = work_reserved_calls,
        work_reserved_tokens = work_reserved_tokens, work_settled_calls = work_settled_calls,
        work_settled_tokens = work_settled_tokens, work_events = work_events,
        check_phase = check_phase, check_id = check_id, check_digest = check_digest, check_outcome = check_outcome, check_exit = check_exit,
        check_stdout = check_stdout, check_stderr = check_stderr, check_stdout_truncated = check_stdout_truncated, check_stderr_truncated = check_stderr_truncated, check_stdout_omitted = check_stdout_omitted, check_stderr_omitted = check_stderr_omitted,
        followup_phase = followup_phase, followup_edit_phase = followup_edit_phase, followup_reserved_calls = followup_reserved_calls, followup_reserved_tokens = followup_reserved_tokens,
        followup_settled_calls = followup_settled_calls, followup_settled_tokens = followup_settled_tokens, followup_events = followup_events,
        followup_check_phase = followup_check_phase, followup_check_id = followup_check_id, followup_check_digest = followup_check_digest,
        followup_check_outcome = followup_check_outcome, followup_check_exit = followup_check_exit, followup_check_stdout = followup_check_stdout,
        followup_check_stderr = followup_check_stderr, followup_check_stdout_truncated = followup_check_stdout_truncated, followup_check_stderr_truncated = followup_check_stderr_truncated, followup_check_stdout_omitted = followup_check_stdout_omitted, followup_check_stderr_omitted = followup_check_stderr_omitted, additional_work = additional };
    let converted: Option<Message<JsonValue>> = Message.new(view).cast<JsonValue>();
    let value = match converted { Some(item) => item.body, None() => { println("REFUSED event view conversion"); return 1; } };
    let raw = match stringify(value) { Ok(item) => item, Err(_) => { println("REFUSED event view encoding"); return 1; } };
    let output = match ascii_json_with(raw, 16777216, 67108864, "event view exceeds bound", "event view exceeds display bound") {
        Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; }
    };
    println("EVENT VIEW untrusted; known literal filtering is incomplete. Text values are JSON strings encoded within the outer JSON.");
    println("EVENT VIEW " + output);
    return 0;
}
