module nomo.entry.harness_work_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.to_string_i32;
import nomo.harness.model_plan_diagnostic.{response_error, response_text};
import nomo.cli.harness_work_args.{Work, parse};
import nomo.harness.harness_work_contract.{Context, Evidence, Ledger, fresh, ledger_error, bump_edit, native_tokens, collect, finish_evidence, context_error};
import nomo.harness.harness_model_tools.{run_context as read_context, work_child_turn, chain_child_turn};
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.harness_work_model.{read_main, edit_plan, edit_child, aggregate};
import nomo.harness.work_chain_context.ParentFacts;
import nomo.harness.work_chain_model.{plan as chain_plan, child as chain_child, aggregate as chain_aggregate};
import nomo.harness.harness_edit_contract.{decode_plan, decode_edit, text_error, decode_work_plan, decode_work_edit, work_summary_error};
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, Prepared, read_original, prepare_original};
import nomo.session.edit_operation_store.available;
import nomo.entry.edit_coordinator.{Approval, Selector, Confirmed, execute};
import nomo.entry.edit_context.{context, completed_context, recorded, display};

flow ledger_text(state: Ledger) -> string {
    return "LEDGER work steps=" + to_string_i32(state.read.steps + state.edit.steps) + "/13 calls=" +
        to_string_i32(state.read.calls + state.edit.calls) + "/7 generation_allowance=" + to_string_i32(state.read.tokens + state.edit.tokens) +
        "/47104 native_token_ceiling=" + to_string_i32(native_tokens(state)) + "/196608";
}
public flow ledger(state: Ledger) -> unit { println(ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume"); }
public flow chain_ledger(state: Ledger) -> unit { println(ledger_text(state) + "; per-turn configured allowances are not measured usage; bounded v2 continuation requires a fresh durable claim and current confirmation"); }
flow chain_stage(name: string, state: Ledger) -> unit { println("STAGE " + name); chain_ledger(state); }

public flow refused(state: Ledger, error: string) -> i32 { println("REFUSED " + error); ledger(state); return 1; }
flow stage(name: string, state: Ledger) -> unit { println("STAGE " + name); ledger(state); }
flow help() -> unit {
    println("One read-context/edit workflow: --id ID --workspace BIND --path EDITFILE --once TASK --allow FILE[,FILE].");
    println("Overall request/read task1..128 printable ASCII;1..2 read paths<=48 characters, raw allow<=97; complete read context<=2048 serialized characters.");
    println("One read/search,4096 scan allowance; complete display result<=256 characters, search yields locations. Edit original/result<=2048 UTF-8 bytes, whole edit/read data<=65536 bytes.");
    println("Maximum13 steps /7 Model calls /47104 generation /196608 native cumulative tokens /3 edit reads with6144-byte allowance /1 atomic attempt. Edit tail reserved before read.");
    println("Exclusive owned disposable workspace/store; native yes then Nomo y/yes. Data-only edit_status, no automatic retries or mutating resume.");
}

public type Failure = { state: Ledger, error: string };
public type Pending = { selected: Selector, prepared: Prepared, evidence: Evidence, request: string, task: string, state: Ledger };
public type Completed = { context: Context, state: Ledger };
public type Summary = { answer: string, state: Ledger };
flow failed(state: Ledger, error: string) -> Result<Pending, Failure> { return Err(Failure { state = state, error = error }); }

// Callers admit the unused edit slot before this shared Model/File preparation.
public flow prepare(input: Work, original_error: (string) -> string, stage_log: (string, Ledger) -> unit, chain_read: bool, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    var state = fresh();
    let selected = Selector { id = input.edit.id, workspace = input.edit.workspace, path = input.edit.path };
    let invalid = ledger_error(state); if invalid != "" { return failed(state, invalid); }
    println("RESERVATION work13 steps/7 calls/47104 generation/196608 native; edit tail6 steps/3 calls/38912 generation/163840 native; one read/search and one atomic maximum");
    let read_result = read_context(input.edit.request, input.allowed, state.read, "read-", true, chain_read, inspect_plan, inspect_all);
    let read = match read_result {
        Ok(value) => value,
        Err(failure) => {
            state = Ledger { read = failure.state, edit = state.edit };
            if !failure.resolved { println("RESERVATION read unresolved; no subsequent edit work"); }
            return failed(state, failure.error);
        }
    };
    state = Ledger { read = read.ledger, edit = state.edit };
    let pending = match collect(read.child, read.status, read.request, read.task, read.allowed) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    let evidence = match finish_evidence(pending, read.answer) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    if evidence.ledger.steps != read.ledger.steps || evidence.ledger.calls != read.ledger.calls || evidence.ledger.tokens != read.ledger.tokens ||
        evidence.ledger.tools != read.ledger.tools || evidence.ledger.scan != read.ledger.scan { return failed(state, "read evidence ledger mismatch"); }
    let before = match read_original(selected.path) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    let original = original_error(before); if original != "" { return failed(state, original); }
    let plan = Context { edit = context("plan", selected, input.edit.request, "", before), evidence = evidence };
    let error = context_error(plan); if error != "" { return failed(state, error); }
    state = match bump_edit(state, true) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    stage_log("edit-plan", state);
    let plan_raw = perform LegacyEditStages.plan(plan);
    if inspect_all { println(response_text(plan_raw, "edit-plan", "lab-qwen-", 4096)); }
    let decoded_plan = if chain_read { decode_work_plan(plan_raw) } else { decode_plan(plan_raw) };
    let task = match decoded_plan { Ok(value) => value, Err(error) => { return failed(state, error); } };
    state = match bump_edit(state, false) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    display("EVENT main -> edit-child request ", task);
    let delegated = Context { edit = context("child", selected, input.edit.request, task, before), evidence = evidence };
    let child_error = context_error(delegated); if child_error != "" { return failed(state, child_error); }
    state = match bump_edit(state, true) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    stage_log("edit-child", state);
    let edit_raw = perform LegacyEditStages.child(delegated);
    if inspect_all { println(response_text(edit_raw, "edit-child", "lab-qwen-", 32768)); }
    let decoded_edit = if chain_read { decode_work_edit(edit_raw) } else { decode_edit(edit_raw) };
    let request = match decoded_edit { Ok(value) => value, Err(error) => { return failed(state, error); } };
    let prepared = match prepare_original(selected.path, before, request.target, request.replacement) { Ok(value) => value, Err(error) => { return failed(state, if chain_read { response_error(edit_raw, "edit-child", "proposal", 32768) } else { error }); } };
    state = match bump_edit(state, false) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    return Ok(Pending { selected = selected, prepared = prepared, evidence = evidence, request = input.edit.request, task = task, state = state });
}

public flow prepare_work(input: Work) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => stage(name, state);
    return prepare(input, original, log, false, false, false) with {
        LegacyStringStages.main(value) => { resume read_main(value); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume edit_plan(value); }
        LegacyEditStages.child(value) => { resume edit_child(value); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value); }
    };
}
public flow prepare_chain_work(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    let original = (value: string) => match expected { Some(before) => if value == before { "" } else { "current original differs from confirmed parent result" }, None() => "" };
    let log = (name: string, state: Ledger) => chain_stage(name, state);
    return prepare(input, original, log, true, inspect_plan, inspect_all) with {
        LegacyStringStages.main(value) => { resume read_main(value); }
        LegacyStringStages.child(task, files, selected) => { resume chain_child_turn(task, files, selected, inspect_all); }
        LegacyEditStages.plan(value) => { resume chain_plan(value, parent); }
        LegacyEditStages.child(value) => { resume chain_child(value, parent); }
        LegacyEditStages.aggregate(value) => { resume chain_aggregate(value, parent); }
    };
}

public flow completed_context_work(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    let state = match bump_edit(pending.state, false) { Ok(value) => value,
        Err(error) => { return Err(Failure { state = pending.state, error = "edit completed; " + error }); } };
    let final = Context { edit = completed_context(pending.request, pending.task, pending.prepared.proposal.before, outcome), evidence = pending.evidence };
    let error = context_error(final); if error != "" { return Err(Failure { state = state, error = "edit completed; " + error }); }
    return Ok(Completed { context = final, state = state });
}

public flow finish_edit(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    recorded(pending.selected); return completed_context_work(pending, outcome);
}

public flow finish_summary(completed: Completed, stage_log: (string, Ledger) -> unit, work: bool, inspect_all: bool) -> Result<Summary, Failure> {
    let state = match bump_edit(completed.state, true) { Ok(value) => value,
        Err(error) => { return Err(Failure { state = completed.state, error = "edit completed; " + error }); } };
    stage_log("edit-aggregate", state);
    let answer = perform LegacyEditStages.aggregate(completed.context);
    if inspect_all { println(response_text(answer, "edit-aggregate", "lab-qwen-", 512)); }
    let error = if work { work_summary_error(answer) } else { text_error(answer, "final answer") }; if error != "" { return Err(Failure { state = state, error = "edit completed; " + error }); }
    return Ok(Summary { answer = answer, state = state });
}

public flow summarize(completed: Completed) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => stage(name, state);
    return finish_summary(completed, log, false, false) with {
        LegacyEditStages.plan(value) => { resume edit_plan(value); }
        LegacyEditStages.child(value) => { resume edit_child(value); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value); }
    };
}
public flow summarize_chain(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => chain_stage(name, state);
    return finish_summary(completed, log, true, inspect_all) with {
        LegacyEditStages.plan(value) => { resume chain_plan(value, parent); }
        LegacyEditStages.child(value) => { resume chain_child(value, parent); }
        LegacyEditStages.aggregate(value) => { resume chain_aggregate(value, parent); }
    };
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let input = match parse(args) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if input.edit.help { help(); return 0; }
    match available() { Ok(_) => {} Err(error) => { return refused(fresh(), error); } }
    let pending = match prepare_work(input) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let outcome = match execute(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    let completed = match finish_edit(pending, outcome) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let summary = match summarize(completed) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    display("FINAL ", summary.answer); ledger(summary.state); return 0;
}
