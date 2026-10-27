module nomo.entry.harness_edit_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.to_string_i32;
import nomo.cli.harness_edit_args.parse;
import nomo.harness.harness_edit_contract.{Ledger, fresh, bump, context_error, decode_edit, decode_plan, text_error};
import nomo.harness.harness_model_edit.{plan, propose, aggregate};
import nomo.tools.edit_file.{EditableRoot, read_original, prepare_original};
import nomo.session.edit_operation_store.available;
import nomo.entry.edit_coordinator.{Approval, Selector, execute};
import nomo.entry.edit_context.{context, completed_context, recorded, display};

flow ledger(state: Ledger) -> unit {
    println("LEDGER steps=" + to_string_i32(state.steps) + "/6 calls=" + to_string_i32(state.calls) +
        "/3 token_allowance=" + to_string_i32(state.tokens) + "/38912 boundaries=" + to_string_i32(state.boundaries) +
        "/3 native_token_allowance=" + to_string_i32(state.native_tokens) + "/163840; allowances are not provider usage; journal does not persist model history or budgets");
}
flow refused(state: Ledger, error: string) -> i32 { println("REFUSED " + error); ledger(state); return 1; }
flow stage(phase: string, state: Ledger) -> unit {
    println("STAGE " + phase + " child-1 steps=" + to_string_i32(state.steps) + " calls=" + to_string_i32(state.calls) +
        " token_allowance=" + to_string_i32(state.tokens) + " remaining_calls=" + to_string_i32(3 - state.calls) +
        " remaining_token_allowance=" + to_string_i32(38912 - state.tokens) +
        " native_token_allowance=" + to_string_i32(state.native_tokens) + " remaining_native_token_allowance=" + to_string_i32(163840 - state.native_tokens));
}
flow help() -> unit {
    println("Nomo one-shot model edit: --id ID --workspace BIND --path FILE --once TASK (flags in any order).");
    println("One exclusive owned disposable workspace/store; one existing NUL-free UTF-8 file, 1..2048 bytes before and at most2048 after.");
    println("Task/delegation/summary1..512 UTF-8 bytes; child literal edit JSON<=32768 bytes; complete model context<=65536 bytes.");
    println("Maximum6 orchestration steps /3 Model attempts /38912 token allowance /3 file reads (6144-byte allowance) /1 atomic replacement.");
    println("Native cumulative token ceiling163840 includes input and output; generation limits4096/32768/2048, native allocations32768/65536/65536.");
    println("Current native yes then Nomo y/yes; same/different ID cannot reuse a consumed store. Journal stores edit facts, not model history or resume.");
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    var state = fresh();
    let input = match parse(args) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    if input.help { help(); return 0; }
    let selected = Selector { id = input.id, workspace = input.workspace, path = input.path };
    // Before File or Model, every existing slot consumes the invocation.
    match available() { Ok(_) => {} Err(error) => { return refused(state, error); } }
    let before = match read_original(input.path) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let initial = context("plan", selected, input.request, "", before);
    let invalid = context_error(initial); if invalid != "" { return refused(state, invalid); }
    state = match bump(state, true) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    stage("plan", state);
    let task = match decode_plan(plan(initial)) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    state = match bump(state, false) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    display("EVENT main -> child-1 request ", task);
    let delegated = context("child", selected, input.request, task, before);
    let invalid_child = context_error(delegated); if invalid_child != "" { return refused(state, invalid_child); }
    state = match bump(state, true) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    stage("child", state);
    let request = match decode_edit(propose(delegated)) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let prepared = match prepare_original(input.path, before, request.target, request.replacement) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    state = match bump(state, false) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let outcome = match execute(selected, prepared) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    // Source receives a typed value only after the shared coordinator proves
    // durable completion. Announce it before a Model abort can terminate here.
    recorded(selected);
    state = match bump(state, false) { Ok(value) => value, Err(error) => { return refused(state, "edit completed; " + error); } };
    println("EVENT child-1 -> main completed " + outcome.binding.id);
    let final_context = completed_context(input.request, task, before, outcome);
    let invalid_final = context_error(final_context);
    if invalid_final != "" { return refused(state, "edit completed; aggregation context refused: " + invalid_final); }
    state = match bump(state, true) { Ok(value) => value, Err(error) => { return refused(state, "edit completed; " + error); } };
    stage("aggregate", state);
    let answer = aggregate(final_context);
    let invalid_answer = text_error(answer, "final answer");
    if invalid_answer != "" { return refused(state, "edit completed; " + invalid_answer); }
    display("FINAL ", answer); ledger(state); return 0;
}
