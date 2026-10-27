module nomo.entry.harness_work_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.to_string_i32;
import nomo.cli.harness_work_args.parse;
import nomo.harness.harness_work_contract.{Context, Ledger, fresh, ledger_error, bump_edit, native_tokens, collect, finish_evidence, context_error};
import nomo.harness.harness_model_tools.run_work_context;
import nomo.harness.harness_work_model.{edit_plan, edit_child, aggregate};
import nomo.harness.harness_edit_contract.{decode_plan, decode_edit, text_error};
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, read_original, prepare_original};
import nomo.session.edit_operation_store.available;
import nomo.entry.edit_coordinator.{Approval, Selector, execute};
import nomo.entry.edit_context.{context, completed_context, recorded, display};

flow ledger(state: Ledger) -> unit {
    println("LEDGER work steps=" + to_string_i32(state.read.steps + state.edit.steps) + "/13 calls=" +
        to_string_i32(state.read.calls + state.edit.calls) + "/7 generation_allowance=" + to_string_i32(state.read.tokens + state.edit.tokens) +
        "/47104 native_token_ceiling=" + to_string_i32(native_tokens(state)) + "/196608; configured allowances are not measured usage; no persisted Model history or mutating resume");
}
flow refused(state: Ledger, error: string) -> i32 { println("REFUSED " + error); ledger(state); return 1; }
flow stage(name: string, state: Ledger) -> unit { println("STAGE " + name); ledger(state); }
flow help() -> unit {
    println("One read-context/edit workflow: --id ID --workspace BIND --path EDITFILE --once TASK --allow FILE[,FILE].");
    println("Overall request/read task1..128 printable ASCII;1..2 read paths<=48 characters, raw allow<=97; complete read context<=2048 serialized characters.");
    println("One read/search,4096 scan allowance; complete display result<=256 characters, search yields locations. Edit original/result<=2048 UTF-8 bytes, whole edit/read data<=65536 bytes.");
    println("Maximum13 steps /7 Model calls /47104 generation /196608 native cumulative tokens /3 edit reads with6144-byte allowance /1 atomic attempt. Edit tail reserved before read.");
    println("Exclusive owned disposable workspace/store; native yes then Nomo y/yes. Data-only edit_status, no automatic retries or mutating resume.");
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    var state = fresh();
    let input = match parse(args) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    if input.edit.help { help(); return 0; }
    let selected = Selector { id = input.edit.id, workspace = input.edit.workspace, path = input.edit.path };
    match available() { Ok(_) => {} Err(error) => { return refused(state, error); } }
    let invalid = ledger_error(state); if invalid != "" { return refused(state, invalid); }
    println("RESERVATION work13 steps/7 calls/47104 generation/196608 native; edit tail6 steps/3 calls/38912 generation/163840 native; one read/search and one atomic maximum");
    let read = match run_work_context(input.edit.request, input.allowed, state.read) {
        Ok(value) => value,
        Err(failure) => {
            state = Ledger { read = failure.state, edit = state.edit };
            if !failure.resolved { println("RESERVATION read unresolved; no subsequent edit work"); }
            return refused(state, failure.error);
        }
    };
    state = Ledger { read = read.ledger, edit = state.edit };
    let pending = match collect(read.child, read.status, read.request, read.task, read.allowed) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let evidence = match finish_evidence(pending, read.answer) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    if evidence.ledger.steps != read.ledger.steps || evidence.ledger.calls != read.ledger.calls || evidence.ledger.tokens != read.ledger.tokens ||
        evidence.ledger.tools != read.ledger.tools || evidence.ledger.scan != read.ledger.scan { return refused(state, "read evidence ledger mismatch"); }
    let before = match read_original(selected.path) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let plan = Context { edit = context("plan", selected, input.edit.request, "", before), evidence = evidence };
    let error = context_error(plan); if error != "" { return refused(state, error); }
    state = match bump_edit(state, true) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    stage("edit-plan", state);
    let task = match decode_plan(edit_plan(plan)) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    state = match bump_edit(state, false) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    display("EVENT main -> edit-child request ", task);
    let delegated = Context { edit = context("child", selected, input.edit.request, task, before), evidence = evidence };
    let child_error = context_error(delegated); if child_error != "" { return refused(state, child_error); }
    state = match bump_edit(state, true) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    stage("edit-child", state);
    let request = match decode_edit(edit_child(delegated)) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let prepared = match prepare_original(selected.path, before, request.target, request.replacement) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    state = match bump_edit(state, false) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    let outcome = match execute(selected, prepared) { Ok(value) => value, Err(error) => { return refused(state, error); } };
    recorded(selected);
    state = match bump_edit(state, false) { Ok(value) => value, Err(error) => { return refused(state, "edit completed; " + error); } };
    let final = Context { edit = completed_context(input.edit.request, task, before, outcome), evidence = evidence };
    let final_error = context_error(final); if final_error != "" { return refused(state, "edit completed; " + final_error); }
    state = match bump_edit(state, true) { Ok(value) => value, Err(error) => { return refused(state, "edit completed; " + error); } };
    stage("edit-aggregate", state);
    let answer = aggregate(final);
    let answer_error = text_error(answer, "final answer"); if answer_error != "" { return refused(state, "edit completed; " + answer_error); }
    display("FINAL ", answer); ledger(state); return 0;
}
