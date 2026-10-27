module nomo.entry.harness_edit_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.to_string_i32;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.cli.harness_edit_args.{Input, parse};
import nomo.harness.harness_edit_contract.{Context, Ledger, fresh, bump, context_error, decode_edit, decode_plan, text_error};
import nomo.harness.harness_model_edit.{plan, propose, aggregate};
import nomo.tools.edit_file.{EditableRoot, read_original, prepare_original};
import nomo.tools.edit_encoding.json;
import nomo.session.edit_operation_store.available;
import nomo.entry.edit_coordinator.{Approval, Selector, Confirmed, execute};

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
flow context(phase: string, input: Input, task: string, before: string) -> Context {
    return Context { phase = phase, request = input.request, task = task, id = input.id, workspace = input.workspace,
        path = input.path, before = before, after = "", request_digest = "", before_digest = "", after_digest = "",
        before_bytes = byte_count(utf8_encode(before)), after_bytes = 0, completed = false };
}
flow completed_context(input: Input, task: string, before: string, outcome: Confirmed) -> Context {
    let selected = outcome.binding;
    return Context { phase = "aggregate", request = input.request, task = task, id = selected.id, workspace = selected.workspace,
        path = selected.path, before = before, after = outcome.after, request_digest = selected.request_digest,
        before_digest = selected.before_digest, after_digest = selected.after_digest,
        before_bytes = selected.before_bytes, after_bytes = selected.after_bytes, completed = true };
}
flow recorded(input: Input) -> unit {
    println("EDIT completed " + input.id + "; aggregation cannot change the recorded outcome; do not replay.");
    match json(["edit_status", "--id", input.id, "--workspace", input.workspace, "--path", input.path]) {
        Ok(value) => { println("NEXT " + value); }
        Err(_) => { println("Recorded operation is available through edit_status with the same selectors."); }
    }
}
flow display(prefix: string, text: string) -> unit {
    match json([text]) { Ok(value) => { println(prefix + value); } Err(error) => { abort(error); } }
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
    // Before File or Model, every existing slot consumes the invocation.
    match available() { Ok(_) => {} Err(error) => { return refused(state, error); } }
    let before = match read_original(input.path) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let initial = context("plan", input, "", before);
    let invalid = context_error(initial); if invalid != "" { return refused(state, invalid); }
    state = match bump(state, true) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    stage("plan", state);
    let task = match decode_plan(plan(initial)) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    state = match bump(state, false) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    display("EVENT main -> child-1 request ", task);
    let delegated = context("child", input, task, before);
    let invalid_child = context_error(delegated); if invalid_child != "" { return refused(state, invalid_child); }
    state = match bump(state, true) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    stage("child", state);
    let request = match decode_edit(propose(delegated)) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let prepared = match prepare_original(input.path, before, request.target, request.replacement) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    state = match bump(state, false) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let selected = Selector { id = input.id, workspace = input.workspace, path = input.path };
    let outcome = match execute(selected, prepared) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    // Source receives a typed value only after the shared coordinator proves
    // durable completion. Announce it before a Model abort can terminate here.
    recorded(input);
    state = match bump(state, false) { Ok(value) => value, Err(error) => { return refused(state, "edit completed; " + error); } };
    println("EVENT child-1 -> main completed " + outcome.binding.id);
    let final_context = completed_context(input, task, before, outcome);
    let invalid_final = context_error(final_context);
    if invalid_final != "" { return refused(state, "edit completed; aggregation context refused: " + invalid_final); }
    state = match bump(state, true) { Ok(value) => value, Err(error) => { return refused(state, "edit completed; " + error); } };
    stage("aggregate", state);
    let answer = aggregate(final_context);
    let invalid_answer = text_error(answer, "final answer");
    if invalid_answer != "" { return refused(state, "edit completed; " + invalid_answer); }
    display("FINAL ", answer); ledger(state); return 0;
}
