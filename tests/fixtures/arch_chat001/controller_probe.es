module app.chat_stage_probe;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.resources.ReadOnlyRoot;
import std.text.char_count as len;
import std.text.split;
import nomo.domain.conversation.Event;
import nomo.domain.conversation.State;
import nomo.domain.harness.loop.Session;
import nomo.domain.harness.loop.LoopTurn;
import nomo.domain.harness.loop.Context as ChildContext;
import nomo.domain.harness.loop.context_error as child_context_error;
import nomo.domain.harness.loop.ReadLedger;
import nomo.domain.harness.read.Observed;
import nomo.domain.harness.read.numbers as canonical_numbers;
import nomo.domain.harness.read.numbers as legacy_numbers;
import nomo.bootstrap.harness.ascii_read_child_turn as child_turn;
import nomo.domain.harness.chat.Previous;
import nomo.domain.harness.chat.Invocation;
import nomo.domain.harness.chat.Context;
import nomo.domain.harness.chat.Completed;
import nomo.domain.harness.chat.TurnResult;
import nomo.domain.harness.chat.empty;
import nomo.domain.harness.chat.fresh_invocation;
import nomo.domain.harness.chat.seed;
import nomo.domain.harness.chat.chat_context_error as context_error;
import nomo.bootstrap.harness.ascii_chat_run_turn_controller as run_turn_controller;
import nomo.bootstrap.harness.harness_tool_chat_run_turn as run_turn;
import nomo.application.harness.ports.LegacyChatStages;
import nomo.adapters.cli.harness.harness_model_tools_chat_run as chat_run;
import nomo.adapters.cli.checkpoints.harness_checkpoint_entry_run_init as run_init;
import nomo.adapters.cli.checkpoints.run_save;
import nomo.adapters.cli.checkpoints.harness_checkpoint_entry_run_show as run_show;
import nomo.adapters.cli.checkpoints.run_continue;
import nomo.adapters.cli.checkpoints.harness_successor_entry_run_show as successor_show;

// This exact shape/helper is copied from the unchanged original pure fixture.
// Only its original zero_call_child_context_proven Check is embedded below.
type OriginalCheck = { label: string, mode: string, ledger: ReadLedger, usage: ReadLedger, maximum: ReadLedger, invocation: Invocation,
    prior: Previous, context: Context, child: Session, legacy: Session, status: i32, allowed: Array<string>,
    accepted: bool, expected_ledger: ReadLedger, expected_observed: Observed };
type Vector = { label: string, request: string, allowed: Array<string>, before: Invocation, plan: Context,
    aggregate: Context, task: string, selected: State, child: LoopTurn, raw_plan: string, answer: string,
    expected: TurnResult };
flow slash() -> string { return std.text.from_char('\\'); }
flow event(role: string, kind: string, name: string, text: string) -> Event {
    return Event { role = role, kind = kind, name = name, text = text };
}
flow sample(events: Array<Event>, spent: i32, calls: usize, tokens: usize, tools: usize, scan: usize) -> Session {
    var characters: usize = 0;
    for item in events limit Iterations(12) { characters = characters + len(item.name) + len(item.text); }
    return Session { history = State { events = events, characters = characters, spent = spent, stopped = false },
        calls = calls, tokens = tokens, tools = tools, scan = scan };
}
flow original_zero_check() -> OriginalCheck { return __ORIGINAL_ZERO_CHECK__; }
flow vector_zero() -> Vector {
    let original = original_zero_check();
    let prior = original.prior;
    let expected_seed = [event("user", "context", "original", "Q"),
        event("user", "context", "task", prior.task), event("user", "context", "result", prior.result),
        event("user", "context", "tool", prior.tool), event("user", "context", "outcome", prior.outcome),
        event("user", "context", "answer", prior.answer)];
    let selected_session = sample(expected_seed, 0, 0, 0, 0, 0);
    let selected = selected_session.history;
    return __ZERO_VECTOR__;
}
flow vectors() -> Array<Vector> { return __VECTORS__; }

// The same actual controller interprets both stages. No local workflow clone,
// native inference, File, store, admission or additional child is used here.
flow exercise(item: Vector, invocation: Invocation) -> TurnResult {
    println("CASE " + item.label);
    if invocation != item.before { abort("first actual Invocation changed before second turn"); }
    let actual = run_turn_controller(item.request, item.allowed, invocation) with {
        LegacyChatStages.main(value) => {
            let expected = if value.phase == "plan" { item.plan } else { item.aggregate };
            if value != expected { abort("complete main Context differs"); }
            if value.phase != "plan" && value.phase != "aggregate" { abort("unknown main phase"); }
            println("PORT " + item.label + " main." + value.phase);
            let response = if value.phase == "plan" { item.raw_plan } else { item.answer };
            response
        }
        LegacyChatStages.child(task, files, selected, _, _, _, _) => {
            if task != item.task || files != item.allowed || selected != item.selected { abort("complete child task/allowed/State differs"); }
            println("PORT " + item.label + " child");
            item.child
        }
    };
    if actual != item.expected { abort("whole TurnResult/Invocation/Completed/Event value differs"); }
    println("PASS " + item.label);
    return actual;
}
public flow numbers_probe(args: Array<string>) -> bool {
    let value = ReadLedger { steps = 12, calls = 7, tokens = 14336, tools = 1, scan = 4096 };
    let expected = "steps=12 calls=7 tokens=14336 tools=1 scan=4096";
    return canonical_numbers(value) == expected && legacy_numbers(value) == expected;
}
public flow observe(args: Array<string>) -> i32 {
    if !numbers_probe(args) { abort("canonical and compatibility numbers differ"); }
    println("PASS numbers_canonical_and_legacy");
    let values = vectors();
    __EXERCISES__
    let original = original_zero_check();
    if original.label != "zero_call_child_context_proven" || !original.accepted || original.status != 4 ||
        original.child.calls != 0 || original.child.tokens != 0 || original.child.tools != 0 || original.child.scan != 0 ||
        original.child.history.spent != 0 { abort("immutable original zero-call vector changed"); }
    let chosen = seed("Q", original.prior);
    let input = sample(chosen.events.push(event("user", "input", "", "T")), 0, 0, 0, 0, 0);
    let child_context = ChildContext { history = input.history.events, allowed = ["a.txt"], final_only = false };
    let zero = vector_zero();
    if context_error(zero.plan) != "" || child_context_error(child_context) !=
        "model context exceeds 2048 serialized characters" { abort("original parent-fits/child-overflow premise changed"); }
    let zero_actual = exercise(zero, zero.before);
    return 0;
}
public flow backend_abort(args: Array<string>) -> i32 {
    println("CASE source_abort");
    let invocation = fresh_invocation();
    let actual = run_turn_controller("Q", ["a.txt"], invocation) with {
        LegacyChatStages.main(value) => {
            let expected = __ABORT_CONTEXT__;
            if value != expected { abort("abort main Context differs"); }
            println("PORT source_abort main.plan");
            abort("D7_EXPECTED_SOURCE_STAGE_ABORT");
        }
        LegacyChatStages.child(_, _, _, _, _, _, _) => abort("UNEXPECTED child after source abort");
    };
    println("UNREACHABLE source abort returned TurnResult");
    return 0;
}

// These production paths are source/effects observations only, never run.
public flow production_facade(args: Array<string>) -> i32 {
    let result = run_turn("Q", ["a.txt"], fresh_invocation()); return result.status;
}
public flow production_child(args: Array<string>) -> i32 {
    let result = child_turn("T", ["a.txt"], seed("Q", empty())); return result.status;
}
public flow entry_checkpoint_init(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] { return run_init(args); }
public flow entry_checkpoint_save(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return run_save(args); }
public flow entry_checkpoint_show(args: Array<string>) -> i32 { return run_show(args); }
public flow entry_successor_continue(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return run_continue(args); }
public flow entry_successor_show(args: Array<string>) -> i32 { return successor_show(args); }
public flow entry_chat(args: Array<string>) -> i32 { return chat_run(args); }
