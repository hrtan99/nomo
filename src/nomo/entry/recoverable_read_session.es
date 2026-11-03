module nomo.entry.recoverable_read_session;

import std.io.println;
import std.text.{len, split};
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import std.collections.len as count;
import nomo.model.model_tool_contract.allowed_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.read_tool_chat.run_private_turn;
import nomo.harness.history_continue_model.{BudgetFacts, run_turn as run_after_work, run_after_followup};
import nomo.session.recoverable_work_facts.snapshot as work_facts;
import nomo.session.event_policy.load as load_policy;
import nomo.session.chat_history.load as load_legacy;
import nomo.session.recoverable_chat_store.{create, load, reserve, finish};
import nomo.session.recoverable_work_store.load as load_recoverable_work;
import nomo.session.recoverable_check_store.load as load_recoverable_check;
import nomo.session.recoverable_followup_store.load as load_recoverable_followup;
import nomo.session.recoverable_followup_check_store.load as load_recoverable_followup_check;
import nomo.session.history_work_guard.inspect as inspect_work;
import nomo.session.history_followup_guard.inspect as inspect_followup;
import nomo.session.history_check_guard.inspect as inspect_check;
import nomo.session.history_followup_check_guard.inspect as inspect_followup_check;
import nomo.session.edit_operation_store.available as edit_available;
import nomo.session.history_followup_edit_store.available as followup_edit_available;
import nomo.session.session_display.escaped;
import nomo.core.conversation.Event;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.session.event_policy.PolicyRoot;

// Explicit opt-in path. It does not silently migrate v1-v3, establish a
// workspace identity, or claim comprehensive secret redaction.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) != 7 || (args[0] != "new" && args[0] != "continue") || args[1] != "--allow" || args[3] != "--once" || args[5] != "--policy-binding" {
        println("REFUSED expected new|continue --allow FILE[,FILE] --once QUESTION"); return 1;
    }
    if len(args[2]) > 97 { println("REFUSED allowlist too long"); return 1; }
    let allowed = split(args[2], ","); let invalid = allowed_error(allowed);
    if invalid != "" || question_error(args[4]) != "" { println("REFUSED invalid read request"); return 1; }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    match load_legacy() { Ok(None()) => {} Ok(Some(_)) => { println("REFUSED legacy session cannot be migrated automatically"); return 1; } Err(error) => { println("REFUSED " + error); return 1; } }
    match inspect_work() { Ok(None()) => {} _ => { println("REFUSED work record exists or is invalid"); return 1; } }
    match inspect_followup() { Ok(None()) => {} _ => { println("REFUSED followup record exists or is invalid"); return 1; } }
    match inspect_check() { Ok(None()) => {} _ => { println("REFUSED check record exists or is invalid"); return 1; } }
    match inspect_followup_check() { Ok(None()) => {} _ => { println("REFUSED followup check exists or is invalid"); return 1; } }
    let binding = args[6];
    let existing = match load(policy, binding) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    if args[0] == "new" {
        match existing { None() => {} Some(_) => { println("REFUSED session already exists"); return 1; } }
        match create(policy, binding) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    } else { match existing { Some(_) => {} None() => { println("REFUSED recoverable session missing"); return 1; } } }
    let current = match load(policy, binding) { Ok(Some(item)) => item, _ => { println("REFUSED recoverable session missing or invalid"); return 1; } };
    let facts = match work_facts(policy, binding) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let version = match reserve(current, args[4], policy, binding) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let running = match load(policy, binding) { Ok(Some(item)) => item, _ => { println("REFUSED reservation missing"); return 1; } };
    if running.version.opaque != version.opaque || running.value.chat.phase != "running" { println("REFUSED reservation changed"); return 1; }
    println("RESERVED chat turn; interruption leaves it unresolved and will not retry.");
    println("A final answer is provisional until SAVED confirms durable history.");
    let result = match facts.first {
        Some(first) => { match facts.followup {
            Some(second) => {
                let usage = running.value.chat.invocation.usage;
                let budget = BudgetFacts { work_calls = facts.calls, work_generation = facts.generation, chat_used_calls = usage.calls, chat_used_generation = usage.tokens, chat_reserved_calls = 4, chat_reserved_generation = 8192 };
                run_after_followup(args[4], allowed, running.value.chat.invocation, first, second, budget)
            }
            None() => run_after_work(args[4], allowed, running.value.chat.invocation, first),
        } }
        None() => run_private_turn(args[4], allowed, running.value.chat.invocation),
    };
    if result.status != 0 || !result.resolved { println("REFUSED chat turn unresolved; inspect without retry"); return 1; }
    match finish(running, result, policy, binding) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    println("SAVED chat and event records together; saved text is untrusted and does not grant authority."); return 0;
}

public type View = { format: i32, encoding: string, phase: string, turns: i32, first_count: usize,
    used_calls: i32, used_tokens: i32, used_tools: i32, used_scan: i32, reserved_calls: i32, reserved_tokens: i32,
    events: Array<Event>, work_phase: string, work_reserved_calls: i32, work_reserved_tokens: i32,
    work_settled_calls: i32, work_settled_tokens: i32, work_events: Array<Event>,
    check_phase: string, check_id: string, check_digest: string, check_outcome: string, check_exit: string,
    check_stdout: string, check_stderr: string, check_stdout_truncated: bool, check_stderr_truncated: bool, check_stdout_omitted: bool, check_stderr_omitted: bool,
    followup_phase: string, followup_reserved_calls: i32, followup_reserved_tokens: i32, followup_settled_calls: i32, followup_settled_tokens: i32, followup_events: Array<Event>,
    followup_check_phase: string, followup_check_id: string, followup_check_digest: string, followup_check_outcome: string, followup_check_exit: string,
    followup_check_stdout: string, followup_check_stderr: string, followup_check_stdout_truncated: bool, followup_check_stderr_truncated: bool, followup_check_stdout_omitted: bool, followup_check_stderr_omitted: bool };

public flow status(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) != 2 || args[0] != "--policy-binding" { println("REFUSED recoverable status requires policy binding"); return 1; }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    match load_legacy() { Ok(None()) => {} _ => { println("REFUSED legacy or invalid session data"); return 1; } }
    let saved = match load(policy, args[1]) { Ok(Some(item)) => item, Ok(None()) => { println("REFUSED recoverable session missing"); return 1; } Err(error) => { println("REFUSED " + error); return 1; } };
    let work = match load_recoverable_work(policy, args[1]) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let check = match load_recoverable_check(policy, args[1]) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let followup = match load_recoverable_followup(policy, args[1]) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let followup_check = match load_recoverable_followup_check(policy, args[1]) { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    var followup_phase = "none"; var followup_reserved_calls: i32 = 0; var followup_reserved_tokens: i32 = 0;
    var followup_settled_calls: i32 = 0; var followup_settled_tokens: i32 = 0; var followup_events: Array<Event> = [];
    match followup { Some(item) => {
        followup_phase = item.value.work.phase; followup_reserved_calls = item.value.work.reserved.calls; followup_reserved_tokens = item.value.work.reserved.generation;
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
    var work_phase = "none"; var work_reserved_calls: i32 = 0; var work_reserved_tokens: i32 = 0;
    var work_settled_calls: i32 = 0; var work_settled_tokens: i32 = 0; var work_events: Array<Event> = [];
    match work {
        Some(item) => {
            work_phase = item.value.work.phase; work_reserved_calls = item.value.work.reserved.calls;
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
    let view = View { format = 1, encoding = saved.value.encoding, phase = saved.value.chat.phase,
        turns = saved.value.events.turns, first_count = saved.value.events.first_count,
        used_calls = used.calls, used_tokens = used.tokens, used_tools = used.tools, used_scan = used.scan,
        reserved_calls = if pending { 4 } else { 0 }, reserved_tokens = if pending { 8192 } else { 0 },
        events = saved.value.events.events, work_phase = work_phase, work_reserved_calls = work_reserved_calls,
        work_reserved_tokens = work_reserved_tokens, work_settled_calls = work_settled_calls,
        work_settled_tokens = work_settled_tokens, work_events = work_events,
        check_phase = check_phase, check_id = check_id, check_digest = check_digest, check_outcome = check_outcome, check_exit = check_exit,
        check_stdout = check_stdout, check_stderr = check_stderr, check_stdout_truncated = check_stdout_truncated, check_stderr_truncated = check_stderr_truncated, check_stdout_omitted = check_stdout_omitted, check_stderr_omitted = check_stderr_omitted,
        followup_phase = followup_phase, followup_reserved_calls = followup_reserved_calls, followup_reserved_tokens = followup_reserved_tokens,
        followup_settled_calls = followup_settled_calls, followup_settled_tokens = followup_settled_tokens, followup_events = followup_events,
        followup_check_phase = followup_check_phase, followup_check_id = followup_check_id, followup_check_digest = followup_check_digest,
        followup_check_outcome = followup_check_outcome, followup_check_exit = followup_check_exit, followup_check_stdout = followup_check_stdout,
        followup_check_stderr = followup_check_stderr, followup_check_stdout_truncated = followup_check_stdout_truncated, followup_check_stderr_truncated = followup_check_stderr_truncated, followup_check_stdout_omitted = followup_check_stdout_omitted, followup_check_stderr_omitted = followup_check_stderr_omitted };
    let converted: Option<Message<JsonValue>> = Message.new(view).cast<JsonValue>();
    let value = match converted { Some(item) => item.body, None() => { println("REFUSED event view conversion"); return 1; } };
    let raw = match stringify(value) { Ok(item) => item, Err(_) => { println("REFUSED event view encoding"); return 1; } };
    if len(raw) > 131072 || byte_count(utf8_encode(raw)) > 131072 { println("REFUSED event view exceeds bound"); return 1; }
    var output = ""; var size: usize = 0;
    for character in split(raw, "") limit Iterations(131074) {
        let part = escaped(character); size = size + len(part);
        if size > 262144 { println("REFUSED event view exceeds display bound"); return 1; }
        output = output + part;
    }
    println("EVENT VIEW untrusted; known literal filtering is incomplete. Text values are JSON strings encoded within the outer JSON.");
    println("EVENT VIEW " + output);
    return 0;
}
